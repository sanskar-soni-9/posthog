import { IconGear, IconPlusSmall, IconTrash } from '@posthog/icons'
import {
    LemonButton,
    LemonInput,
    LemonLabel,
    LemonSelect,
    LemonSwitch,
    LemonTabs,
    LemonTag,
    Popover,
} from '@posthog/lemon-ui'
import { useActions, useValues } from 'kea'
import { Form } from 'kea-forms'
import { getSeriesColor } from 'lib/colors'
import { SeriesGlyph } from 'lib/components/SeriesGlyph'
import { LemonField } from 'lib/lemon-ui/LemonField'
import { hexToRGBA, lightenDarkenColor, RGBToRGBA } from 'lib/utils'

import { themeLogic } from '~/layout/navigation-3000/themeLogic'

import { AxisSeries, dataVisualizationLogic } from '../dataVisualizationLogic'
import { ySeriesLogic, YSeriesLogicProps, YSeriesSettingsTab } from './ySeriesLogic'

export const SeriesTab = (): JSX.Element => {
    const { columns, numericalColumns, xData, yData, responseLoading } = useValues(dataVisualizationLogic)
    const { updateXSeries, addYSeries } = useActions(dataVisualizationLogic)

    const hideAddYSeries = yData.length >= numericalColumns.length

    const options = columns.map(({ name, type }) => ({
        value: name,
        label: (
            <div className="items-center flex-1">
                {name}
                <LemonTag className="ml-2" type="default">
                    {type.name}
                </LemonTag>
            </div>
        ),
    }))

    return (
        <div className="flex flex-col w-full">
            <LemonLabel>X-axis</LemonLabel>
            <LemonSelect
                className="w-full"
                value={xData !== null ? xData.column.name : 'None'}
                options={options}
                disabledReason={responseLoading ? 'Query loading...' : undefined}
                onChange={(value) => {
                    const column = columns.find((n) => n.name === value)
                    if (column) {
                        updateXSeries(column.name)
                    }
                }}
            />
            <LemonLabel className="mt-4">Y-axis</LemonLabel>
            {yData.map((series, index) => (
                <YSeries series={series} index={index} key={`${series?.column.name}-${index}`} />
            ))}
            {!hideAddYSeries && (
                <LemonButton
                    className="mt-1"
                    type="tertiary"
                    onClick={() => addYSeries()}
                    icon={<IconPlusSmall />}
                    fullWidth
                >
                    Add Y-series
                </LemonButton>
            )}
        </div>
    )
}

const YSeries = ({ series, index }: { series: AxisSeries<number>; index: number }): JSX.Element => {
    const { columns, numericalColumns, responseLoading, dataVisualizationProps } = useValues(dataVisualizationLogic)
    const { updateYSeries, deleteYSeries } = useActions(dataVisualizationLogic)

    const seriesLogicProps: YSeriesLogicProps = { series, seriesIndex: index, dataVisualizationProps }
    const seriesLogic = ySeriesLogic(seriesLogicProps)

    const { isSettingsOpen, canOpenSettings, activeSettingsTab } = useValues(seriesLogic)
    const { setSettingsOpen, submitFormatting, submitDisplay, setSettingsTab } = useActions(seriesLogic)

    const { isDarkModeOn } = useValues(themeLogic)
    const seriesColor = getSeriesColor(index)

    const options = numericalColumns.map(({ name, type }) => ({
        value: name,
        label: (
            <div className="items-center flex flex-1">
                <SeriesGlyph
                    style={{
                        borderColor: seriesColor,
                        color: seriesColor,
                        backgroundColor: isDarkModeOn
                            ? RGBToRGBA(lightenDarkenColor(seriesColor, -20), 0.3)
                            : hexToRGBA(seriesColor, 0.2),
                    }}
                    className="mr-2"
                >
                    <></>
                </SeriesGlyph>
                {name}
                <LemonTag className="ml-2" type="default">
                    {type.name}
                </LemonTag>
            </div>
        ),
    }))

    return (
        <div className="flex gap-1 mb-1">
            <LemonSelect
                className="grow"
                value={series !== null ? series.column.name : 'None'}
                options={options}
                disabledReason={responseLoading ? 'Query loading...' : undefined}
                onChange={(value) => {
                    const column = columns.find((n) => n.name === value)
                    if (column) {
                        updateYSeries(index, column.name)
                    }
                }}
            />
            <Popover
                overlay={
                    <div className="m-2">
                        <LemonTabs
                            activeKey={activeSettingsTab}
                            barClassName="justify-around"
                            onChange={(tab) => setSettingsTab(tab as YSeriesSettingsTab)}
                            tabs={Object.values(Y_SERIES_SETTINGS_TABS).map(({ label, Component }, index) => ({
                                label: label,
                                key: Object.keys(Y_SERIES_SETTINGS_TABS)[index],
                                content: <Component ySeriesLogicProps={seriesLogicProps} />,
                            }))}
                        />
                    </div>
                }
                visible={isSettingsOpen}
                placement="bottom"
                onClickOutside={() => {
                    submitFormatting()
                    submitDisplay()
                }}
            >
                <LemonButton
                    key="seriesSettings"
                    icon={<IconGear />}
                    noPadding
                    onClick={() => setSettingsOpen(true)}
                    disabledReason={!canOpenSettings && 'Select a column first'}
                    disabledReasonWrapperClass="flex"
                />
            </Popover>
            <LemonButton
                key="delete"
                icon={<IconTrash />}
                status="danger"
                title="Delete Y-series"
                noPadding
                onClick={() => deleteYSeries(index)}
            />
        </div>
    )
}

const YSeriesFormattingTab = ({ ySeriesLogicProps }: { ySeriesLogicProps: YSeriesLogicProps }): JSX.Element => {
    return (
        <Form logic={ySeriesLogic} props={ySeriesLogicProps} formKey="formatting" className="space-y-2">
            <LemonField name="style" label="Style" className="gap-1">
                <LemonSelect
                    options={[
                        { value: 'none', label: 'None' },
                        { value: 'number', label: 'Number' },
                        { value: 'percent', label: 'Percentage' },
                    ]}
                />
            </LemonField>
            <LemonField name="prefix" label="Prefix">
                <LemonInput placeholder="$" />
            </LemonField>
            <LemonField name="suffix" label="Suffix">
                <LemonInput placeholder="USD" />
            </LemonField>
            <LemonField name="decimalPlaces" label="Decimal places">
                <LemonInput type="number" min={0} />
            </LemonField>
        </Form>
    )
}

const YSeriesDisplayTab = ({ ySeriesLogicProps }: { ySeriesLogicProps: YSeriesLogicProps }): JSX.Element => {
    return (
        <Form logic={ySeriesLogic} props={ySeriesLogicProps} formKey="display" className="space-y-2">
            <LemonField name="trendLine" label="Trend line">
                {({ value, onChange }) => <LemonSwitch checked={value} onChange={(newValue) => onChange(newValue)} />}
            </LemonField>
        </Form>
    )
}

const Y_SERIES_SETTINGS_TABS = {
    [YSeriesSettingsTab.Formatting]: {
        label: 'Formatting',
        Component: YSeriesFormattingTab,
    },
    [YSeriesSettingsTab.Display]: {
        label: 'Display',
        Component: YSeriesDisplayTab,
    },
}
