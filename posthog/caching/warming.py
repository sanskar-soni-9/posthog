from datetime import timedelta, UTC, datetime
from collections.abc import Generator
from typing import Optional

import structlog
from celery import shared_task
from celery.canvas import chain
from django.db.models import Q
from prometheus_client import Counter
from sentry_sdk import capture_exception

from posthog.api.services.query import process_query_dict
from posthog.caching.utils import largest_teams
from posthog.clickhouse.query_tagging import tag_queries
from posthog.errors import CHQueryErrorTooManySimultaneousQueries
from posthog.hogql_queries.query_cache import QueryCacheManager
from posthog.hogql_queries.legacy_compatibility.flagged_conversion_manager import conversion_to_query_based
from posthog.hogql_queries.query_runner import ExecutionMode
from posthog.models import Team, Insight, DashboardTile
from posthog.schema import GenericCachedQueryResponse
from posthog.tasks.utils import CeleryQueue

logger = structlog.get_logger(__name__)

STALE_INSIGHTS_COUNTER = Counter(
    "posthog_cache_warming_stale_insights",
    "Number of stale insights present",
    ["team_id"],
)
PRIORITY_INSIGHTS_COUNTER = Counter(
    "posthog_cache_warming_priority_insights",
    "Number of priority insights warmed",
    ["team_id", "dashboard", "is_cached"],
)

LAST_VIEWED_THRESHOLD = timedelta(days=7)


def priority_insights(team: Team) -> Generator[tuple[int, Optional[int]], None, None]:
    """
    This is the place to decide which insights should be kept warm.
    The reasoning is that this will be a yes or no decision. If we need to keep it warm, we try our best
    to not let the cache go stale. There isn't any middle ground, like trying to refresh it once a day, since
    that would be like clock that's only right twice a day.
    """

    threshold = datetime.now(UTC) - LAST_VIEWED_THRESHOLD
    QueryCacheManager.clean_up_stale_insights(team_id=team.pk, threshold=threshold)
    combos = QueryCacheManager.get_stale_insights(team_id=team.pk, limit=500)

    STALE_INSIGHTS_COUNTER.labels(team_id=team.pk).inc(len(combos))

    dashboard_q_filter = Q()
    insight_ids_single = set()

    for insight_id, dashboard_id in (combo.split(":") for combo in combos):
        if dashboard_id:
            dashboard_q_filter |= Q(insight_id=insight_id, dashboard_id=dashboard_id)
        else:
            insight_ids_single.add(insight_id)

    if insight_ids_single:
        single_insights = (
            team.insight_set.filter(insightviewed__last_viewed_at__gte=threshold, pk__in=insight_ids_single)
            .distinct()
            .values_list("id", flat=True)
        )
        for single_insight_id in single_insights:
            yield single_insight_id, None

    if not dashboard_q_filter:
        return

    dashboard_tiles = (
        DashboardTile.objects.filter(dashboard__last_accessed_at__gte=threshold)
        .filter(dashboard_q_filter)
        .distinct()
        .values_list("insight_id", "dashboard_id")
    )
    yield from dashboard_tiles


@shared_task(ignore_result=True, expires=60 * 60)
def schedule_warming_for_teams_task():
    team_ids = largest_teams(limit=3)

    teams = Team.objects.filter(Q(pk__in=team_ids) | Q(extra_settings__insights_cache_warming=True))

    logger.info("Warming insight cache: teams", team_ids=[team.pk for team in teams])

    # TODO: Needs additional thoughts about concurrency and rate limiting if we launch chains for a lot of teams at once

    for team in teams:
        insight_tuples = priority_insights(team)

        task_groups = chain(*(warm_insight_cache_task.si(*insight_tuple) for insight_tuple in insight_tuples))
        task_groups.apply_async()


@shared_task(
    queue=CeleryQueue.LONG_RUNNING.value,
    ignore_result=True,
    expires=60 * 60,
    autoretry_for=(CHQueryErrorTooManySimultaneousQueries,),
    retry_backoff=1,
    retry_backoff_max=3,
    max_retries=3,
)
def warm_insight_cache_task(insight_id: int, dashboard_id: int):
    insight = Insight.objects.get(pk=insight_id)
    dashboard = None

    tag_queries(team_id=insight.team_id, insight_id=insight.pk, trigger="warmingV2")
    if dashboard_id:
        tag_queries(dashboard_id=dashboard_id)
        dashboard = insight.dashboards.get(pk=dashboard_id)

    with conversion_to_query_based(insight):
        logger.info(f"Warming insight cache: {insight.pk} for team {insight.team_id} and dashboard {dashboard_id}")

        try:
            results = process_query_dict(
                insight.team,
                insight.query,
                dashboard_filters_json=dashboard.filters if dashboard is not None else None,
                # We need an execution mode with recent cache:
                # - in case someone refreshed after this task was triggered
                # - if insight + dashboard combinations have the same cache key, we prevent needless recalculations
                execution_mode=ExecutionMode.RECENT_CACHE_CALCULATE_BLOCKING_IF_STALE,
            )

            PRIORITY_INSIGHTS_COUNTER.labels(
                team_id=insight.team_id,
                dashboard=dashboard_id is not None,
                is_cached=results.is_cached if isinstance(results, GenericCachedQueryResponse) else False,
            ).inc()
        except Exception as e:
            capture_exception(e)
