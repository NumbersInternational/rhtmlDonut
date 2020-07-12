import _ from 'lodash'
import d3 from 'd3'
import { getLabelDimensionsUsingSvgApproximation, splitIntoLines, ptInArc, findIntersectingLabels } from './labelUtils'
import helpers from '../helpers'
import { rotate, computeIntersection, inclusiveBetween, between, toRadians } from '../math'
import segments from '../segments'
import OuterLabel from './outerLabel'
import InnerLabel from './innerLabel'
import computeOuterConnectionLinePath from './computeOuterConnectionLinePath'
import LabelCollision from '../interrupts/labelCollision'
import AngleThresholdExceeded from '../interrupts/angleThresholdExceeded'
import LabelPushedOffCanvas from '../interrupts/labelPushedOffCanvas'
import CannotMoveToInner from '../interrupts/cannotMoveToInner'
import * as rootLog from 'loglevel'
const labelLogger = rootLog.getLogger('label')

// TODO bit of a temp hack
const spacingBetweenUpperTrianglesAndCenterMeridian = 7

// NB fundamental for understanding a loop of the code : _.each iterations are cancelled if the loop function returns false
const terminateLoop = false // NB this is done for readability to make it more obvious what 'return false' does in a _.each loop
const continueLoop = true // NB this is done for readability to make it more obvious what 'return true' does in a _.each loop

let labels = {
  // NB function used for debug and test purpose only
  drawPlacementLines (pie) {
    const maxFontSize = _(pie.outerLabelData).map('fontSize').max()

    // red dots : the initial placement line
    _.range(0, 360, 2).map(angle => {
      const { fitLineCoord, isLifted } = labels._computeInitialCoordAlongLabelRadiusWithLiftOffAngle({
        angle,
        labelHeight: 10, // made up
        labelOffset: pie.labelOffset,
        labelLiftOffAngle: parseFloat(pie.options.labels.outer.liftOffAngle),
        outerRadius: pie.outerRadius,
        pieCenter: pie.pieCenter,
        canvasHeight: parseFloat(pie.options.size.canvasHeight),
        maxFontSize,
        maxVerticalOffset: pie.maxVerticalOffset
      })
      helpers.showPoint(pie.svg, fitLineCoord, (isLifted) ? 'red' : 'orange')
    })

    // green dots : the adjusted label placement line
    const highestPoint = pie.pieCenter.y - (pie.outerRadius + pie.maxVerticalOffset)
    const lowestPoint = pie.pieCenter.y + (pie.outerRadius + pie.maxVerticalOffset)
    _([0, 180]).each(startAngle => {
      _.range(highestPoint, lowestPoint, 5).map(yCoord => {
        const fakeLabel = new OuterLabel({
          angleExtent: 1 * 360 / 100,
          angleStart: startAngle,
          color: 'black',
          fontFamily: 'arial',
          fontSize: 12,
          id: 'test',
          innerPadding: parseFloat(pie.options.labels.outer.innerPadding),
          label: 'test',
          totalValue: 100,
          value: 2
        })

        // compute label height and labelTextLines and lineHeight
        const { lineHeight, width, height, labelTextLines } = labels.wrapAndFormatLabelUsingSvgApproximation({
          parentContainer: pie.svg,
          labelText: fakeLabel.labelText,
          fontSize: fakeLabel.fontSize,
          fontFamily: fakeLabel.fontFamily,
          maxLabelWidth: parseFloat(pie.options.labels.outer.maxWidth) * pie.options.size.canvasWidth,
          innerPadding: parseFloat(pie.options.labels.outer.innerPadding),
          maxLabelLines: parseFloat(pie.options.labels.outer.maxLines)
        })

        Object.assign(fakeLabel, {
          lineHeight,
          width,
          height,
          labelTextLines,
          pieCenter: pie.pieCenter,
          labelOffset: pie.labelOffset,
          outerRadius: pie.outerRadius
        })

        labels.adjustLabelToNewY({
          parentContainer: pie.svg,
          anchor: 'top',
          newY: yCoord,
          labelDatum: fakeLabel,
          labelRadius: pie.outerRadius + pie.labelOffset,
          yRange: pie.outerRadius + pie.maxVerticalOffset,
          labelLiftOffAngle: parseFloat(pie.options.labels.outer.liftOffAngle),
          pieCenter: pie.pieCenter,
          topIsLifted: false,
          bottomIsLifted: false
        })
        helpers.showPoint(pie.svg, fakeLabel.lineConnectorCoord, 'green')
      })
    })
  },

  // TODO break into small phases and combine with buildLabelSet
  preprocessLabelSet ({
    parentContainer,
    labelSet,
    canvasHeight,
    minFontSize,
    maxFontSize,
    innerPadding,
    outerPadding,
    minAngle,
    maxLabelWidth,
    maxLabelLines
  }) {
    let filteredLabelSet = labelSet.map(label => {
      const { lineHeight, width, height, labelTextLines } = labels.wrapAndFormatLabelUsingSvgApproximation({
        parentContainer,
        labelText: label.labelText,
        fontSize: label.fontSize,
        fontFamily: label.fontFamily,
        maxLabelWidth,
        innerPadding,
        maxLabelLines
      })

      return Object.assign(label, {
        lineHeight,
        width,
        height,
        labelTextLines
      })
    })

    let labelStats = labels.computeLabelStats(filteredLabelSet, outerPadding)
    let maxDesiredHeight = Math.max(labelStats.cumulativeLeftSideLabelHeight, labelStats.cumulativeRightSideLabelHeight)
    let heightDeficit = maxDesiredHeight - canvasHeight

    if (heightDeficit > 0) {
      // apply increasingly aggressive font size scales, until everything is minFontSize
      const fontSizeScaleOptions = _.range(maxFontSize, minFontSize - 1).map((newMaxFontSize, i) => {
        return {
          scale: d3.scale.linear().domain([0, filteredLabelSet.length]).range([newMaxFontSize, minFontSize]),
          minFontSize,
          maxFontSize: newMaxFontSize,
          id: i
        }
      })

      const descendingValuesLabelSet = _(filteredLabelSet).orderBy(['value'], ['desc']).value()

      // NB note both filteredLabelSet and descendingValuesLabelSet are referencing same data items, so mods to one are reflected in the other

      // NB KEY implementation detail : _.each iteration will terminate on return false
      _(fontSizeScaleOptions).each(({ scale, minFontSize, maxFontSize, id }) => {
        _(descendingValuesLabelSet)
          .each((label, i) => {
            const newFontSize = Math.round(scale(i))
            const { lineHeight, width, height, labelTextLines } = labels.wrapAndFormatLabelUsingSvgApproximation({
              parentContainer,
              labelText: label.labelText,
              fontSize: newFontSize,
              fontFamily: label.fontFamily,
              maxLabelWidth,
              innerPadding,
              maxLabelLines
            })

            Object.assign(label, {
              fontSize: newFontSize,
              lineHeight,
              width,
              height,
              labelTextLines
            })
          })

        labelStats = labels.computeLabelStats(filteredLabelSet, outerPadding)

        labelLogger.info(`Applying labelFontScale option ${id}: font range: [${minFontSize}:${maxFontSize}]`)
        labelLogger.info(`New fontSizeDistribution: ${JSON.stringify(labelStats.fontSizeDistribution, {}, 2)}`)

        if (Math.max(labelStats.cumulativeLeftSideLabelHeight, labelStats.cumulativeRightSideLabelHeight) <= canvasHeight) {
          labelLogger.info(`labelFontScale option(${id}):[${minFontSize}:${maxFontSize}] provided enough shrinkage. Moving on to next step`)
          return false // NB break
        }
      })

      if (Math.max(labelStats.cumulativeLeftSideLabelHeight, labelStats.cumulativeRightSideLabelHeight) > canvasHeight) {
        labelLogger.info(`all font shrinking options exhausted, must now start removing labels by increasing minDisplay Angle`)

        // TODO make 0.0005 configurable, or use one of the existing iteration values
        _(_.range(minAngle, 1, 0.0005)).each((newMinAngle) => {
          let labelStats = labels.computeLabelStats(filteredLabelSet, outerPadding)
          let leftSideHeightDeficit = labelStats.cumulativeLeftSideLabelHeight - canvasHeight
          let rightSideHeightDeficit = labelStats.cumulativeRightSideLabelHeight - canvasHeight

          const beforeCount = filteredLabelSet.length
          for (let i = filteredLabelSet.length - 1; i >= 0; i--) {
            let label = filteredLabelSet[i]
            if ((leftSideHeightDeficit > 0 || rightSideHeightDeficit > 0) && label.fractionalValue < newMinAngle) {
              label.labelShown = false
              if (label.hemisphere === 'left') {
                leftSideHeightDeficit -= (label.height + outerPadding)
              }
              if (label.hemisphere === 'right') {
                rightSideHeightDeficit -= (label.height + outerPadding)
              }
            }

            if (leftSideHeightDeficit <= 0 && rightSideHeightDeficit <= 0) {
              break
            }
          }

          filteredLabelSet = filteredLabelSet.filter(datum => datum.labelShown)
          const afterCount = filteredLabelSet.length
          labelStats = labels.computeLabelStats(filteredLabelSet, outerPadding)
          maxDesiredHeight = Math.max(labelStats.cumulativeLeftSideLabelHeight, labelStats.cumulativeRightSideLabelHeight)

          labelLogger.info(`Applied new minAngle ${newMinAngle}. Before count ${beforeCount} after count ${afterCount}. New maxDesiredHeight:${maxDesiredHeight}, canvasHeight:${canvasHeight}`)

          if (maxDesiredHeight <= canvasHeight) {
            labelLogger.info(`new minDisplay angle ${newMinAngle} provided enough shrinkage. Moving on to next step`)
            return false // NB break
          }
        })
      }
    }
    return filteredLabelSet
  },

  /**
   * Entry point that performs all labelling
   * @param pie
   */
  doLabelling: function (pie) {
    labels.clearPreviousLabelling(pie.svg, pie.cssPrefix)

    // naively place label
    labels.computeInitialLabelCoordinates(pie)

    // adjust label positions to try to accommodate conflicts
    labels.performCollisionResolution(pie)

    labels.shortenTopAndBottom(pie)

    labels.drawOuterLabels(pie)

    labels.drawInnerLabels(pie)

    // only add them if they're actually enabled
    if (pie.options.labels.lines.enabled) {
      labels.drawOuterLabelLines(pie)
      labels.drawInnerLabelLines(pie)
    }

    labels.fadeInLabelsAndLines(pie)
  },

  clearPreviousLabelling: function (parentContainer, cssPrefix) {
    parentContainer.selectAll(`.${cssPrefix}labels-outer`).remove()
    parentContainer.selectAll(`.${cssPrefix}labels-inner`).remove()
    parentContainer.selectAll(`.${cssPrefix}labels-extra`).remove() // TODO dont need
    parentContainer.selectAll(`.${cssPrefix}labels-group`).remove()
    parentContainer.selectAll(`.${cssPrefix}lineGroups-outer`).remove()
    parentContainer.selectAll(`.${cssPrefix}lineGroups-inner`).remove()
    parentContainer.selectAll(`.${cssPrefix}tooltips`).remove() // TODO shouldn't be done here. Also wont work any more (not in parentContainer
    parentContainer.selectAll(`.${cssPrefix}gtooltips`).remove() // TODO shouldn't be done here. Also wont work any more (not in parentContainer
  },

  computeInitialLabelCoordinates: function (pie) {
    pie.maxFontSize = _(pie.outerLabelData).map('fontSize').max()

    // TODO hard coded ranges
    const topApexLabel = _(pie.outerLabelData)
      .filter(labelData => inclusiveBetween(87, labelData.segmentAngleMidpoint, 93))
      .minBy(labelDatum => Math.abs(90 - labelDatum.segmentAngleMidpoint))

    const bottomApexLabel = _(pie.outerLabelData)
      .filter(labelData => inclusiveBetween(267, labelData.segmentAngleMidpoint, 273))
      .minBy(labelDatum => Math.abs(270 - labelDatum.segmentAngleMidpoint))

    if (topApexLabel) {
      labelLogger.info('has top apex label')
      pie.hasTopLabel = true
      topApexLabel.isTopApexLabel = true
    } else {
      pie.hasTopLabel = false
    }

    if (bottomApexLabel) {
      labelLogger.info('has bottom apex label')
      pie.hasBottomLabel = true
      bottomApexLabel.isBottomApexLabel = true
    } else {
      pie.hasBottomLabel = false
    }

    // First place labels using a liftOff of 0, then check for collisions and only lift
    // if there are any collisions do we apply a liftOffAngle
    _(pie.outerLabelData).each(label => {
      labels.placeLabelAlongLabelRadiusWithLiftOffAngle({
        labelDatum: label,
        labelOffset: pie.labelOffset,
        labelLiftOffAngle: 0,
        outerRadius: pie.outerRadius,
        pieCenter: pie.pieCenter,
        canvasHeight: parseFloat(pie.options.size.canvasHeight),
        maxFontSize: pie.maxFontSize,
        maxVerticalOffset: pie.maxVerticalOffset,
        hasTopLabel: pie.hasTopLabel,
        hasBottomLabel: pie.hasBottomLabel,
        minGap: parseFloat(pie.options.labels.outer.outerPadding)
      })
    })

    const topLabelsThatCouldBeLifted = pie.outerLabelData
      .filter(({ segmentAngleMidpoint }) => between(90 - parseFloat(pie.options.labels.outer.liftOffAngle), segmentAngleMidpoint, 90 + parseFloat(pie.options.labels.outer.liftOffAngle)))
    const collisionsInTopSet = findIntersectingLabels(topLabelsThatCouldBeLifted)
    if (collisionsInTopSet.length > 0) {
      labelLogger.info(`Collisions between ${90 - parseFloat(pie.options.labels.outer.liftOffAngle)} - ${90 + parseFloat(pie.options.labels.outer.liftOffAngle)}, applying liftoff spacing`)
      pie.topIsLifted = true
      _(topLabelsThatCouldBeLifted).each(label => {
        labels.placeLabelAlongLabelRadiusWithLiftOffAngle({
          labelDatum: label,
          labelOffset: pie.labelOffset,
          labelLiftOffAngle: parseFloat(pie.options.labels.outer.liftOffAngle),
          outerRadius: pie.outerRadius,
          pieCenter: pie.pieCenter,
          canvasHeight: parseFloat(pie.options.size.canvasHeight),
          maxFontSize: pie.maxFontSize,
          maxVerticalOffset: pie.maxVerticalOffset,
          hasTopLabel: pie.hasTopLabel,
          hasBottomLabel: pie.hasBottomLabel,
          minGap: parseFloat(pie.options.labels.outer.outerPadding)
        })
      })
    }

    const bottomLabelsThatCouldBeLifted = pie.outerLabelData
      .filter(({ segmentAngleMidpoint }) => between(270 - parseFloat(pie.options.labels.outer.liftOffAngle), segmentAngleMidpoint, 270 + parseFloat(pie.options.labels.outer.liftOffAngle)))
    const collisionsInBottomSet = findIntersectingLabels(bottomLabelsThatCouldBeLifted)
    if (collisionsInBottomSet.length > 0) {
      labelLogger.info(`Collisions between ${270 - parseFloat(pie.options.labels.outer.liftOffAngle)} - ${270 + parseFloat(pie.options.labels.outer.liftOffAngle)}, applying liftoff spacing`)
      pie.bottomIsLifted = true
      _(bottomLabelsThatCouldBeLifted).each(label => {
        labels.placeLabelAlongLabelRadiusWithLiftOffAngle({
          labelDatum: label,
          labelOffset: pie.labelOffset,
          labelLiftOffAngle: parseFloat(pie.options.labels.outer.liftOffAngle),
          outerRadius: pie.outerRadius,
          pieCenter: pie.pieCenter,
          canvasHeight: parseFloat(pie.options.size.canvasHeight),
          maxFontSize: pie.maxFontSize,
          maxVerticalOffset: pie.maxVerticalOffset,
          hasTopLabel: pie.hasTopLabel,
          hasBottomLabel: pie.hasBottomLabel,
          minGap: parseFloat(pie.options.labels.outer.outerPadding)
        })
      })
    }
  },

  // TODO need to doc this using an image, and test that it lines up with computeXGivenY
  // TODO this fn is now useless, as it too is a wrapper
  placeLabelAlongLabelRadiusWithLiftOffAngle: function ({
    labelDatum,
    labelOffset,
    labelLiftOffAngle,
    outerRadius,
    pieCenter,
    canvasHeight,
    maxFontSize,
    maxVerticalOffset,
    hasTopLabel = false,
    hasBottomLabel = false,
    minGap = 1
  }) {
    if (labelDatum.isTopApexLabel) {
      const coordAtZeroDegreesAlongOuterRadius = { x: pieCenter.x - outerRadius, y: pieCenter.y }
      const segmentCoord = rotate(coordAtZeroDegreesAlongOuterRadius, pieCenter, labelDatum.segmentAngleMidpoint)

      const fitLineCoord = {
        x: segmentCoord.x,
        y: Math.min( // NB do not allow really big labels to push pack inside outerRadius mark
          pieCenter.y - (outerRadius + maxVerticalOffset - labelDatum.height),
          pieCenter.y - outerRadius - labelOffset
        )
      }
      labelDatum.placeLabelViaConnectorCoord(fitLineCoord)
    } else if (labelDatum.isBottomApexLabel) {
      const coordAtZeroDegreesAlongOuterRadius = { x: pieCenter.x - outerRadius, y: pieCenter.y }
      const segmentCoord = rotate(coordAtZeroDegreesAlongOuterRadius, pieCenter, labelDatum.segmentAngleMidpoint)

      const fitLineCoord = {
        x: segmentCoord.x,
        y: Math.max( // NB do not allow really big labels to push pack inside outerRadius mark
          pieCenter.y + (outerRadius + maxVerticalOffset - labelDatum.height),
          pieCenter.y + outerRadius + labelOffset
        )
      }
      labelDatum.placeLabelViaConnectorCoord(fitLineCoord)
    } else {
      const { fitLineCoord, isLifted } = labels._computeInitialCoordAlongLabelRadiusWithLiftOffAngle({
        angle: labelDatum.segmentAngleMidpoint,
        labelHeight: labelDatum.height,
        labelOffset,
        labelLiftOffAngle,
        outerRadius,
        pieCenter,
        canvasHeight,
        maxFontSize,
        maxVerticalOffset,
        hasTopLabel,
        hasBottomLabel,
        minGap
      })
      labelDatum.placeLabelViaConnectorCoord(fitLineCoord)
      labelDatum.isLifted = isLifted
    }
  },

  _computeInitialCoordAlongLabelRadiusWithLiftOffAngle: function ({
    angle,
    labelHeight,
    labelLiftOffAngle,
    pieCenter,
    outerRadius,
    labelOffset,
    canvasHeight,
    maxFontSize,
    maxVerticalOffset,
    hasTopLabel = false,
    hasBottomLabel = false,
    minGap = 1
  }) {
    let fitLineCoord = null
    let isLifted = false

    const highYOffSetAngle = (angle) => (between(90 - labelLiftOffAngle, angle, 90 + labelLiftOffAngle) || between(270 - labelLiftOffAngle, angle, 270 + labelLiftOffAngle))
    const pointAtZeroDegreesAlongLabelOffset = { x: pieCenter.x - outerRadius - labelOffset, y: pieCenter.y }

    if (highYOffSetAngle(angle)) {
      const radialCoord = rotate(pointAtZeroDegreesAlongLabelOffset, pieCenter, angle)
      const radialLine = [pieCenter, radialCoord]

      let placementLineCoord1 = {}
      placementLineCoord1.y = (between(0, angle, 180))
        ? pieCenter.y - (outerRadius + maxVerticalOffset) + ((hasTopLabel) ? (maxFontSize + minGap) : 0)
        : pieCenter.y + (outerRadius + maxVerticalOffset) - ((hasBottomLabel) ? (maxFontSize + minGap) : 0)
      placementLineCoord1.x = (between(0, angle, 90) || between(270, angle, 360))
        ? pieCenter.x - spacingBetweenUpperTrianglesAndCenterMeridian
        : pieCenter.x + spacingBetweenUpperTrianglesAndCenterMeridian

      let placementLineCoord2 = null
      if (between(0, angle, 90)) {
        placementLineCoord2 = rotate(pointAtZeroDegreesAlongLabelOffset, pieCenter, 90 - labelLiftOffAngle)
      } else if (between(90, angle, 180)) {
        placementLineCoord2 = rotate(pointAtZeroDegreesAlongLabelOffset, pieCenter, 90 + labelLiftOffAngle)
      } else if (between(180, angle, 270)) {
        placementLineCoord2 = rotate(pointAtZeroDegreesAlongLabelOffset, pieCenter, 270 - labelLiftOffAngle)
      } else {
        placementLineCoord2 = rotate(pointAtZeroDegreesAlongLabelOffset, pieCenter, 270 + labelLiftOffAngle)
      }

      const placementLine = [placementLineCoord1, placementLineCoord2]

      const intersection = computeIntersection(radialLine, placementLine)

      if (intersection) {
        fitLineCoord = intersection
        if (fitLineCoord.y < 0) { fitLineCoord.y = 0 }
        if (fitLineCoord.y + labelHeight > canvasHeight) { fitLineCoord.y = canvasHeight - labelHeight }
        isLifted = true
      } else {
        labelLogger.error(`unexpected condition. could not compute intersection with placementLine for label at angle ${angle}`)
        fitLineCoord = rotate(pointAtZeroDegreesAlongLabelOffset, pieCenter, angle)
      }
    } else {
      fitLineCoord = rotate(pointAtZeroDegreesAlongLabelOffset, pieCenter, angle)
    }

    return { fitLineCoord, isLifted }
  },

  drawOuterLabelLines: function (pie) {
    let basisInterpolationFunction = d3.svg.line()
      .x(d => d.x)
      .y(d => d.y)
      .interpolate('basis')

    const outerLabelLines = pie.outerLabelData.map(labelData => {
      const { path, pathType } = computeOuterConnectionLinePath({
        labelData,
        basisInterpolationFunction,
        canvasHeight: parseFloat(pie.options.size.canvasHeight),
        options: pie.options.labels.lines.outer
      })

      return {
        id: labelData.id,
        color: labelData.color,
        path,
        pathType
      }
    })

    let lineGroups = pie.svg.insert('g', `.${pie.cssPrefix}pieChart`) // meaning, BEFORE .pieChart
      .attr('class', `${pie.cssPrefix}lineGroups-outer`)
      .style('opacity', 1)

    let lineGroup = lineGroups.selectAll(`.${pie.cssPrefix}lineGroup`)
      .data(outerLabelLines)
      .enter()
      .append('g')
      .attr('class', d => `${pie.cssPrefix}lineGroup pathType-${d.pathType}`)
      .attr('id', d => `${pie.cssPrefix}lineGroup-${d.id}`)

    lineGroup.append('path')
      .attr('d', d => d.path)
      .attr('stroke', d => d.color)
      .attr('stroke-width', 1)
      .attr('fill', 'none')
      .style('opacity', 1)
      .style('display', 'inline')
  },

  drawInnerLabelLines: function (pie) {
    pie.innerLabelLines = pie.innerLabelData
      .map(labelData => {
        return labels.computeInnerLabelLine({
          pieCenter: pie.pieCenter,
          innerRadius: pie.innerRadius,
          labelData
        })
      })

    let lineGroups = pie.svg.insert('g', `.${pie.cssPrefix}pieChart`) // meaning, BEFORE .pieChart
      .attr('class', `${pie.cssPrefix}lineGroups-inner`)
      .style('opacity', 1)

    let lineGroup = lineGroups.selectAll(`.${pie.cssPrefix}lineGroup`)
      .data(pie.innerLabelLines)
      .enter()
      .append('g')
      .attr('class', function (d) { return `${pie.cssPrefix}lineGroup ${pie.cssPrefix}lineGroup-${d[0].id}` })

    let lineFunction = d3.svg.line()
      .x(function (d) { return d.x })
      .y(function (d) { return d.y })
      .interpolate('basis')

    lineGroup.append('path')
      .attr('d', lineFunction)
      .attr('stroke', function (d) { return d[0].color })
      .attr('stroke-width', 1)
      .attr('fill', 'none')
      .style('opacity', 1)
      .style('display', 'inline')
  },

  computeInnerLabelLine: function ({ pieCenter, innerRadius, labelData }) {
    const pointAtZeroDegrees = { x: pieCenter.x - innerRadius, y: pieCenter.y }
    let originCoords = rotate(pointAtZeroDegrees, pieCenter, labelData.segmentAngleMidpoint)
    originCoords.id = labelData.id
    originCoords.color = labelData.color

    let end = labelData.lineConnectorCoord

    let mid = {
      x: originCoords.x + (end.x - originCoords.x) * 0.5,
      y: originCoords.y + (end.y - originCoords.y) * 0.5,
      type: 'mid'
    }

    switch (labelData.segmentQuadrant) {
      case 4: // top left
        mid.y += Math.abs(end.y - originCoords.y) * 0.25
        break
      case 3: // bottom left
        mid.y -= Math.abs(end.y - originCoords.y) * 0.25
        break
      case 1: // top right
        mid.y += Math.abs(end.y - originCoords.y) * 0.25
        break
      case 2: // bottom right
        mid.y -= Math.abs(end.y - originCoords.y) * 0.25
        break
    }

    return [originCoords, end]
    // return [originCoords, mid, end]
  },

  drawOuterLabels: function (pie) {
    labels.drawLabelSet({
      outerContainer: pie.svg,
      cssPrefix: pie.cssPrefix,
      labelData: pie.outerLabelData,
      labelColor: pie.options.labels.mainLabel.color,
      innerPadding: pie.options.labels.outer.innerPadding,
      labelType: 'outer'
    })
  },

  drawInnerLabels: function (pie) {
    labels.drawLabelSet({
      outerContainer: pie.svg,
      cssPrefix: pie.cssPrefix,
      labelData: pie.innerLabelData,
      labelColor: pie.options.labels.mainLabel.color,
      innerPadding: pie.options.labels.outer.innerPadding,
      labelType: 'inner'
    })
  },

  drawLabelSet: function ({ outerContainer, cssPrefix, labelData, labelColor, innerPadding, labelType }) {
    let labelContainer = outerContainer.insert('g', `.${cssPrefix}labels-${labelType}`)
      .attr('class', `${cssPrefix}labels-${labelType}`)

    let labelGroup = labelContainer.selectAll(`.${cssPrefix}labelGroup-${labelType}`)
      .data(labelData)
      .enter()
      .append('g')
      .attr('id', function (d) { return `${cssPrefix}labelGroup${d.id}-${labelType}` })
      .attr('data-line-angle', d => (d.labelLineAngle) ? d.labelLineAngle.toFixed(3) : '')
      .attr('data-segmentangle', d => (d.segmentAngleMidpoint) ? d.segmentAngleMidpoint.toFixed(3) : '')
      .attr('data-index', function (d) { return d.id })
      .attr('class', `${cssPrefix}labelGroup-${labelType}`)
      .attr('transform', function ({ topLeftCoord }) { return `translate(${topLeftCoord.x},${topLeftCoord.y})` })
      .style('opacity', 1)

    labelGroup.append('text')
      .attr('id', function (d) { return `${cssPrefix}segmentMainLabel${d.id}-${labelType}` })
      .attr('class', `${cssPrefix}segmentMainLabel-outer`)
      .attr('x', 0)
      .attr('y', 0)
      .attr('dy', 0)
      .style('dominant-baseline', 'text-before-edge')
      .style('fill', labelColor)
      .each(function (d) {
        const textGroup = d3.select(this)
        _(d.labelTextLines).each((lineText, i) => {
          textGroup.append('tspan')
            .attr('x', 0)
            .attr('y', i * (d.fontSize + innerPadding))
            .style('font-size', function (d) { return d.fontSize + 'px' })
            .style('font-family', function (d) { return d.fontFamily })
            .style('dominant-baseline', 'text-before-edge')
            .text(lineText)
        })
      })
  },

  fadeInLabelsAndLines: function (pie) {
    // fade in the labels when the load effect is complete - or immediately if there's no load effect
    let loadSpeed = (pie.options.effects.load.effect === 'default') ? pie.options.effects.load.speed : 1
    setTimeout(function () {
      let labelFadeInTime = (pie.options.effects.load.effect === 'default') ? 400 : 1 // 400 is hardcoded for the present

      d3.selectAll('.' + pie.cssPrefix + 'labelGroup-outer')
        .transition()
        .duration(labelFadeInTime)
        .style('opacity', function (d, i) {
          let percentage = pie.options.labels.outer.hideWhenLessThanPercentage
          let segmentPercentage = segments.getPercentage(pie, i, pie.options.labels.percentage.decimalPlaces)
          return (percentage !== null && segmentPercentage < percentage) ? 0 : 1
        })

      d3.selectAll('g.' + pie.cssPrefix + 'lineGroups')
        .transition()
        .duration(labelFadeInTime)
        .style('opacity', 1)

      // once everything's done loading, trigger the onload callback if defined
      if (helpers.isFunction(pie.options.callbacks.onload)) {
        setTimeout(function () {
          try {
            pie.options.callbacks.onload()
          } catch (e) { }
        }, labelFadeInTime)
      }
    }, loadSpeed)
  },

  performCollisionResolution: function (pie) {
    if (pie.outerLabelData.length <= 1) { return }

    if (pie.options.labels.stages.outOfBoundsCorrection) {
      labels.correctOutOfBoundLabelsPreservingOrder({
        outerRadius: pie.outerRadius,
        maxVerticalOffset: pie.maxVerticalOffset,
        labelSet: pie.outerLabelData,
        pieCenter: pie.pieCenter,
        canvasHeight: parseFloat(pie.options.size.canvasHeight),
        canvasWidth: parseFloat(pie.options.size.canvasWidth),
        labelRadius: pie.outerRadius + pie.labelOffset,
        labelLiftOffAngle: parseFloat(pie.options.labels.outer.liftOffAngle),
        outerPadding: parseFloat(pie.options.labels.outer.outerPadding),
        hasTopLabel: pie.hasTopLabel,
        hasBottomLabel: pie.hasBottomLabel,
        maxFontSize: pie.maxFontSize,
        topIsLifted: pie.topIsLifted,
        bottomIsLifted: pie.bottomIsLifted
      })
    }

    // use to determine what order should we hide labels as necessary
    const removalOrder = _(pie.outerLabelData)
      .orderBy(['value', 'id'], ['acs', 'desc'])
      .map('id')
      .value()

    // TODO normalize the config variables for initial vs max for both maxlineAngle and minValue
    labels._performCollisionResolutionIteration({
      totalSegmentCount: pie.options.data.content.length,
      useInnerLabels: pie.options.labels.outer.innerLabels,
      minAngleThreshold: parseFloat(pie.options.data.minAngle),
      breakOutAngleThreshold: 0.1,
      // for now make maxLineAngleValue == maxLineAngleMaxValue so that this strategy is temp dissabled
      maxLineAngleValue: parseFloat(pie.options.labels.outer.labelMaxLineAngle),
      maxLineAngleMaxValue: parseFloat(pie.options.labels.outer.labelMaxLineAngle),
      maxLineAngleIncrement: 3,
      labelSet: pie.outerLabelData,
      removalOrder,
      pie })
  },

  _performCollisionResolutionIteration ({
    totalSegmentCount,
    iterationCount = 0,
    useInnerLabels,
    minAngleThreshold,
    labelSet,
    maxLineAngleValue,
    maxLineAngleMaxValue,
    maxLineAngleIncrement,
    removalOrder,
    breakOutAngleThreshold,
    pie,
    iterationStrategies = {
      removeLabel: 0,
      maxAngleIncreases: 0
    }
  }) {
    const clonedLabelSet = _.cloneDeep(labelSet)
    labelLogger.info(`collision iteration started. iterationCount=${iterationCount} labelCount=${clonedLabelSet.length}`)

    try {
      let { candidateOuterLabelSet, candidateInnerLabelSet } = labels._performCollisionResolutionAlgorithm({
        iterationCount,
        pie,
        clonedAndFilteredLabelSet: clonedLabelSet,
        useInnerLabels,
        maxLineAngleValue
      })

      if (candidateOuterLabelSet.length > 0 || candidateInnerLabelSet.length > 0) {
        pie.outerLabelData = candidateOuterLabelSet
        pie.innerLabelData = candidateInnerLabelSet
      } else {
        labelLogger.error(`collision resolution failed: it tried to removed all labels!`)
      }
    } catch (error) {
      if (error.isInterrupt) {
        const offendingLabel = error.labelDatum
        labelLogger.warn(`collision iteration failed: label '${offendingLabel.label}' triggered ${error.type}: ${error.description}`)

        /* four strategies :
         * lift top/bottom if not lifted. If both already lifted,
         * then start dropping the labels for the smallest segment
         * then increase maxLabelLineAngle threshold
           * not currently used, is enabled when maxLineAngleValue != maxLineAngleMaxValue via config
        */

        const availableStrategies = {
          liftTop: offendingLabel.inTopHalf && !pie.topIsLifted,
          liftBottom: offendingLabel.inBottomHalf && !pie.bottomIsLifted,
          removeLabel: removalOrder.length > 0,
          increaseMaxLabelLineAngle: maxLineAngleValue < maxLineAngleMaxValue
        }

        let newMinAngleThreshold = minAngleThreshold

        if (availableStrategies.liftTop) {
          labelLogger.info('lifting top labels before next iteration')
          // note this is the 'master labelSet', not the clone passed to each iteration
          const topLabelsThatCouldBeLifted = labelSet
            .filter(({ segmentAngleMidpoint }) => between(90 - parseFloat(pie.options.labels.outer.liftOffAngle), segmentAngleMidpoint, 90 + parseFloat(pie.options.labels.outer.liftOffAngle)))
          pie.topIsLifted = true
          _(topLabelsThatCouldBeLifted).each(label => {
            labels.placeLabelAlongLabelRadiusWithLiftOffAngle({
              labelDatum: label,
              labelOffset: pie.labelOffset,
              labelLiftOffAngle: parseFloat(pie.options.labels.outer.liftOffAngle),
              outerRadius: pie.outerRadius,
              pieCenter: pie.pieCenter,
              canvasHeight: parseFloat(pie.options.size.canvasHeight),
              maxFontSize: pie.maxFontSize,
              maxVerticalOffset: pie.maxVerticalOffset,
              hasTopLabel: pie.hasTopLabel,
              hasBottomLabel: pie.hasBottomLabel,
              minGap: parseFloat(pie.options.labels.outer.outerPadding)
            })
          })
        } else if (availableStrategies.liftBottom) {
          labelLogger.info('lifting bottom labels before next iteration')
          // note this is the 'master labelSet', not the clone passed to each iteration
          pie.bottomIsLifted = true
          _(labelSet)
            .filter(({ segmentAngleMidpoint }) => between(270 - parseFloat(pie.options.labels.outer.liftOffAngle), segmentAngleMidpoint, 270 + parseFloat(pie.options.labels.outer.liftOffAngle)))
            .each(label => {
              labels.placeLabelAlongLabelRadiusWithLiftOffAngle({
                labelDatum: label,
                labelOffset: pie.labelOffset,
                labelLiftOffAngle: parseFloat(pie.options.labels.outer.liftOffAngle),
                outerRadius: pie.outerRadius,
                pieCenter: pie.pieCenter,
                canvasHeight: parseFloat(pie.options.size.canvasHeight),
                maxFontSize: pie.maxFontSize,
                maxVerticalOffset: pie.maxVerticalOffset,
                hasTopLabel: pie.hasTopLabel,
                hasBottomLabel: pie.hasBottomLabel,
                minGap: parseFloat(pie.options.labels.outer.outerPadding)
              })
            })
        // TODO this makes it really clear that newMinAngleThreshold should be renamed to minValueThreshold
        } else if (
          availableStrategies.removeLabel &&
          (!availableStrategies.increaseMaxLabelLineAngle || iterationStrategies.removeLabel < (iterationStrategies.maxAngleIncreases + 1) * 10)
        ) {
          iterationStrategies.removeLabel++

          if (pie.options.data.sortOrder === 'initial' && pie.options.labels.strategies.unorderedTieBreak === 'best') {
            // sort by value, then as a tiebreak choose the label closest to the current offending label
            // removing a label closer to the offending label is more likely to solve the current labelling issue
            let idToRemove = _(labelSet)
              .sortBy('value', ({ id }) => Math.abs(offendingLabel.id - id))
              .map('id')
              .first()

            removalOrder = removalOrder
              .filter(label => (label.id !== idToRemove))

            labelSet = _(labelSet)
              .filter(label => {
                if (label.id === idToRemove) { labelLogger.debug(`removing ${pl(label)} ${label.segmentQuadrant}`) }
                return (label.id !== idToRemove)
              })
              .value()
          } else {
            const idToRemove = removalOrder.shift()
            labelSet = _(labelSet)
              .filter(label => {
                if (label.id === idToRemove) { labelLogger.debug(`removing ${pl(label)} ${label.segmentQuadrant}`) }
                return (label.id !== idToRemove)
              })
              .value()
          }
        } else if (availableStrategies.increaseMaxLabelLineAngle) {
          iterationStrategies.maxAngleIncreases++
          maxLineAngleValue += maxLineAngleIncrement
          labelLogger.info(`increased maxLineAngleValue to ${maxLineAngleValue}`)
        } else {
          labelLogger.error(`collision resolution failed: hit breakOutValue: ${breakOutAngleThreshold} and maxLineAngleMaxValue: ${maxLineAngleMaxValue}`)
        }

        labels._performCollisionResolutionIteration({
          totalSegmentCount,
          iterationCount: iterationCount + 1,
          useInnerLabels,
          minAngleThreshold: newMinAngleThreshold,
          labelSet: labelSet, // NB it is the original labelset (potentially w/ labels removed, topIsLifted modified, and bottomIsLifted modified), not the modified cloned version one from the failed iteration, as we do not want to start with the modified positions each time
          breakOutAngleThreshold,
          maxLineAngleValue,
          maxLineAngleMaxValue,
          maxLineAngleIncrement,
          removalOrder,
          pie,
          iterationStrategies
        })
      } else {
        labelLogger.error(`collision resolution failed: unexpected error: ${error}`)
        labelLogger.error(error)
      }
    }
  },

  _performCollisionResolutionAlgorithm ({
    iterationCount,
    pie,
    clonedAndFilteredLabelSet: outerLabelSet,
    useInnerLabels,
    maxLineAngleValue
  }) {
    // NB could backfire : adding apex labels to both sets ...
    const leftOuterLabelsSortedTopToBottom = _(outerLabelSet)
      .filter(label => label.inLeftHalf || label.isTopApexLabel || label.isBottomApexLabel)
      .sortBy(['lineConnectorCoord.y', x => { return -1 * x.id }])
      .value()

    const rightOuterLabelsSortedTopToBottom = _(outerLabelSet)
      .filter(label => label.inRightHalf || label.isTopApexLabel || label.isBottomApexLabel)
      .sortBy(['lineConnectorCoord.y', x => { return -1 * x.id }])
      .value()

    const innerLabelSet = []
    const canUseInnerLabelsInTheseQuadrants = (useInnerLabels)
      ? [1, 2, 3]
      : []

    // NB at some point we should do both innerLabelling and performInitialClusterSpacing. However,
    // at present they dont work well together as the initialSpacing makes inner labels unecessary, even though the user may have preferred        the innerLabels to the spacing.
    if (pie.options.labels.stages.initialClusterSpacing && !useInnerLabels) {
      labels.performInitialClusterSpacing({
        outerLabelSetSortedTopToBottom: leftOuterLabelsSortedTopToBottom,
        innerLabelSet,
        outerRadius: pie.outerRadius,
        maxVerticalOffset: pie.maxVerticalOffset,
        canUseInnerLabelsInTheseQuadrants,
        hemisphere: 'left',
        pieCenter: pie.pieCenter,
        canvasHeight: parseFloat(pie.options.size.canvasHeight),
        innerLabelRadius: pie.innerRadius - pie.labelOffset,
        innerRadius: pie.innerRadius,
        outerLabelRadius: pie.outerRadius + pie.labelOffset,
        horizontalPadding: parseFloat(pie.options.labels.mainLabel.horizontalPadding),
        labelLiftOffAngle: parseFloat(pie.options.labels.outer.liftOffAngle),
        maxAngleBetweenRadialAndLabelLines: maxLineAngleValue,
        minGap: parseFloat(pie.options.labels.outer.outerPadding),
        maxFontSize: pie.maxFontSize,
        hasTopLabel: pie.hasTopLabel,
        hasBottomLabel: pie.hasBottomLabel,
        topIsLifted: pie.topIsLifted,
        bottomIsLifted: pie.bottomIsLifted
      })

      labels.performInitialClusterSpacing({
        outerLabelSetSortedTopToBottom: rightOuterLabelsSortedTopToBottom,
        innerLabelSet,
        outerRadius: pie.outerRadius,
        maxVerticalOffset: pie.maxVerticalOffset,
        canUseInnerLabelsInTheseQuadrants,
        hemisphere: 'right',
        pieCenter: pie.pieCenter,
        canvasHeight: parseFloat(pie.options.size.canvasHeight),
        innerLabelRadius: pie.innerRadius - pie.labelOffset,
        innerRadius: pie.innerRadius,
        outerLabelRadius: pie.outerRadius + pie.labelOffset,
        horizontalPadding: parseFloat(pie.options.labels.mainLabel.horizontalPadding),
        labelLiftOffAngle: parseFloat(pie.options.labels.outer.liftOffAngle),
        maxAngleBetweenRadialAndLabelLines: maxLineAngleValue,
        minGap: parseFloat(pie.options.labels.outer.outerPadding),
        maxFontSize: pie.maxFontSize,
        hasTopLabel: pie.hasTopLabel,
        hasBottomLabel: pie.hasBottomLabel,
        topIsLifted: pie.topIsLifted,
        bottomIsLifted: pie.bottomIsLifted
      })
    }

    labels.performTwoPhaseLabelAdjustment({
      pie,
      stages: pie.options.labels.stages,
      outerLabelSet: leftOuterLabelsSortedTopToBottom,
      innerLabelSet,
      outerRadius: pie.outerRadius,
      maxVerticalOffset: pie.maxVerticalOffset,
      canUseInnerLabelsInTheseQuadrants,
      hemisphere: 'left',
      pieCenter: pie.pieCenter,
      canvasHeight: parseFloat(pie.options.size.canvasHeight),
      innerLabelRadius: pie.innerRadius - pie.labelOffset,
      innerRadius: pie.innerRadius,
      outerLabelRadius: pie.outerRadius + pie.labelOffset,
      horizontalPadding: parseFloat(pie.options.labels.mainLabel.horizontalPadding),
      labelLiftOffAngle: parseFloat(pie.options.labels.outer.liftOffAngle),
      maxAngleBetweenRadialAndLabelLines: maxLineAngleValue,
      minGap: parseFloat(pie.options.labels.outer.outerPadding),
      maxFontSize: pie.maxFontSize,
      hasTopLabel: pie.hasTopLabel,
      hasBottomLabel: pie.hasBottomLabel,
      topIsLifted: pie.topIsLifted,
      bottomIsLifted: pie.bottomIsLifted
    })

    labels.performTwoPhaseLabelAdjustment({
      pie,
      stages: pie.options.labels.stages,
      outerLabelSet: rightOuterLabelsSortedTopToBottom,
      innerLabelSet,
      outerRadius: pie.outerRadius,
      maxVerticalOffset: pie.maxVerticalOffset,
      canUseInnerLabelsInTheseQuadrants,
      hemisphere: 'right',
      pieCenter: pie.pieCenter,
      canvasHeight: parseFloat(pie.options.size.canvasHeight),
      innerLabelRadius: pie.innerRadius - pie.labelOffset,
      innerRadius: pie.innerRadius,
      outerLabelRadius: pie.outerRadius + pie.labelOffset,
      horizontalPadding: parseFloat(pie.options.labels.mainLabel.horizontalPadding),
      labelLiftOffAngle: parseFloat(pie.options.labels.outer.liftOffAngle),
      maxAngleBetweenRadialAndLabelLines: maxLineAngleValue,
      minGap: parseFloat(pie.options.labels.outer.outerPadding),
      maxFontSize: pie.maxFontSize,
      hasTopLabel: pie.hasTopLabel,
      hasBottomLabel: pie.hasBottomLabel,
      topIsLifted: pie.topIsLifted,
      bottomIsLifted: pie.bottomIsLifted
    })

    outerLabelSet = outerLabelSet.filter(label => label.labelShown)

    return {
      candidateOuterLabelSet: outerLabelSet,
      candidateInnerLabelSet: innerLabelSet
    }
  },

  adjustLabelToNewY ({
    parentContainer, // TODO delete . this is temp for debug
    anchor, // top or bottom
    newY,
    labelDatum,
    labelRadius,
    yRange,
    labelLiftOffAngle,
    pieCenter,
    topIsLifted,
    bottomIsLifted
  }) {
    let newTopYCoord = null
    let isLifted = false
    if (anchor === 'top') {
      newTopYCoord = newY
    } else if (anchor === 'bottom') {
      newTopYCoord = newY - labelDatum.height
    }

    // TODO move to label
    let numTextRows = labelDatum.labelTextLines.length
    let { innerPadding, lineHeight } = labelDatum
    let newLineConnectorYCoord = (newTopYCoord < pieCenter.y)
      ? newTopYCoord + (numTextRows - 1) * (innerPadding + lineHeight) + 0.5 * lineHeight
      : newTopYCoord + 0.5 * lineHeight

    let yOffset = Math.abs(pieCenter.y - newLineConnectorYCoord)

    if (yOffset > yRange) {
      console.warn(`yOffset(${yOffset}) cannot be greater than yRange(${yRange})`)
      yOffset = yRange
    }

    const labelLiftOffAngleInRadians = ((labelDatum.inTopHalf && topIsLifted) || (labelDatum.inBottomHalf && bottomIsLifted))
      ? toRadians(labelLiftOffAngle)
      : 0

    const yPosWhereLabelRadiusAndUpperTriangleMeet = labelRadius * Math.cos(labelLiftOffAngleInRadians)
    const xPosWhereLabelRadiusAndUpperTriangleMeet = labelRadius * Math.sin(labelLiftOffAngleInRadians)
    let xOffset = 0

    if (yOffset <= yPosWhereLabelRadiusAndUpperTriangleMeet) {
      // place X along labelRadius
      // step 1. Given the yOffset and the labelRadius, use pythagorem to compute the xOffset that places label along labelRadius
      xOffset = Math.sqrt(Math.pow(labelRadius, 2) - Math.pow(yOffset, 2))
    } else {
      // place X along upper triangle
      // step 1. Given [x,y]PosWhereLabelRadiusAndUpperTriangleMeet, and yRange, compute the upperTriangleYAngle
      isLifted = true
      const yLengthOfUpperTriangle = yRange - yPosWhereLabelRadiusAndUpperTriangleMeet
      const xLengthOfUpperTriangle = xPosWhereLabelRadiusAndUpperTriangleMeet
      const upperTriangleYAngleInRadians = Math.atan(xLengthOfUpperTriangle / yLengthOfUpperTriangle)

      // step 2. Given the upperTriangleYAngle and the yOffset, determine the xOffset that places the label that places it along the upperTriange
      const yLengthOfLabelOnUpperTriangle = yRange - yOffset
      xOffset = yLengthOfLabelOnUpperTriangle * Math.tan(upperTriangleYAngleInRadians) + spacingBetweenUpperTrianglesAndCenterMeridian
    }

    const newLineConnectorCoord = {
      x: (labelDatum.hemisphere === 'left') ? pieCenter.x - xOffset : pieCenter.x + xOffset,
      y: newY
    }

    labelDatum.isLifted = isLifted
    if (anchor === 'top') {
      labelDatum.setTopMedialPoint(newLineConnectorCoord)
    } else {
      labelDatum.setBottomMedialPoint(newLineConnectorCoord)
    }
  },

  correctOutOfBoundLabelsPreservingOrder ({ labelSet, labelLiftOffAngle, labelRadius, canvasHeight, canvasWidth, pieCenter, outerPadding, outerRadius, maxVerticalOffset, hasTopLabel, hasBottomLabel, maxFontSize, topIsLifted, bottomIsLifted }) {
    const newYPositions = {}
    const useYFromLookupTableAndCorrectX = (yPositionLookupTable, anchor) => {
      return (labelDatum) => {
        let apexLabelCorrection = 0
        if ((labelDatum.topLeftCoord.x < pieCenter.x && hasTopLabel) ||
            (labelDatum.topLeftCoord.x > pieCenter.x && hasBottomLabel)) {
          apexLabelCorrection = maxFontSize + outerPadding
        }

        labels.adjustLabelToNewY({
          anchor,
          newY: yPositionLookupTable[labelDatum.id],
          labelRadius,
          yRange: outerRadius + maxVerticalOffset - apexLabelCorrection,
          labelLiftOffAngle,
          labelDatum,
          pieCenter,
          topIsLifted,
          bottomIsLifted
        })
        return labelDatum
      }
    }

    const labelsOverTop = _(labelSet)
      .filter((datum) => { return datum.topLeftCoord.y < 0 })

    const leftLabelsOverTop = labelsOverTop
      .filter({ hemisphere: 'left' })

    const rightLabelsOverTop = labelsOverTop
      .filter({ hemisphere: 'right' })

    // NB 'last' ID in left hemi must get y closest to zero to stay on top (i.e. preserving order)
    leftLabelsOverTop
      .sortBy('id')
      .map('id')
      .reverse()
      .each((leftIdOverTop, index) => {
        newYPositions[leftIdOverTop] = outerPadding + 0.01 * index
      })

    // NB 'first' ID in right hemi must get y closest to zero to stay on top (i.e. preserving order)
    rightLabelsOverTop
      .sortBy('id')
      .map('id')
      .each((rightIdOverTop, index) => {
        newYPositions[rightIdOverTop] = outerPadding + 0.01 * index
      })

    const labelsUnderBottom = _(labelSet)
      .filter((datum) => { return datum.topLeftCoord.y + datum.height > canvasHeight })

    const leftLabelsUnderBottom = labelsUnderBottom
      .filter({ hemisphere: 'left' })

    const rightLabelsUnderBottom = labelsUnderBottom
      .filter({ hemisphere: 'right' })

    // NB 'first' ID in left hemi must get y closest to max to stay on bottom (i.e. preserving order)
    const leftLabelsUnderBottomSortedById = leftLabelsUnderBottom.sortBy('id')
      .value()

    _(leftLabelsUnderBottomSortedById).each((labelDatum, index) => {
      const id = labelDatum.id
      if (index === 0) {
        newYPositions[id] = canvasHeight - outerPadding - 0.01 - labelDatum.height
      } else {
        const previousLabelNewYPosition = newYPositions[leftLabelsUnderBottomSortedById[index - 1].id]
        const maxYPositionToStayInBounds = canvasHeight - labelDatum.height
        newYPositions[id] = Math.min(maxYPositionToStayInBounds, previousLabelNewYPosition - 0.01)
      }
    })

    // NB 'last' ID in right hemi must get y closest to max to stay on bottom (i.e. preserving order)
    const rightLabelsUnderBottomSortedById = rightLabelsUnderBottom.sortBy('id')
      .reverse()
      .value()

    _(rightLabelsUnderBottomSortedById).each((labelDatum, index) => {
      const id = labelDatum.id
      if (index === 0) {
        newYPositions[id] = canvasHeight - outerPadding - 0.01 - labelDatum.height
      } else {
        const previousLabelNewYPosition = newYPositions[rightLabelsUnderBottomSortedById[index - 1].id]
        const maxYPositionToStayInBounds = canvasHeight - labelDatum.height
        newYPositions[id] = Math.min(maxYPositionToStayInBounds, previousLabelNewYPosition - 0.01)
      }
    })

    _(leftLabelsOverTop).each(useYFromLookupTableAndCorrectX(newYPositions, 'top'))
    _(rightLabelsOverTop).each(useYFromLookupTableAndCorrectX(newYPositions, 'top'))
    _(leftLabelsUnderBottom).each(useYFromLookupTableAndCorrectX(newYPositions, 'top'))
    _(rightLabelsUnderBottom).each(useYFromLookupTableAndCorrectX(newYPositions, 'top'))

    const labelsOverlappingRightEdgeCount = _(labelSet)
      .filter((datum) => { return datum.topLeftCoord.x + datum.width > canvasWidth })
      .map((datum) => {
        datum.topLeftCoord.x = canvasWidth - datum.width
        return datum
      })
      .size()

    const labelsOverlappingLeftEdgeCount = _(labelSet)
      .filter((datum) => { return datum.topLeftCoord.x < 0 })
      .map((datum) => {
        datum.topLeftCoord.x = 0
        return datum
      })
      .size()

    labelLogger.info(`corrected ${leftLabelsOverTop.size()} left labels over top`)
    labelLogger.info(`corrected ${rightLabelsOverTop.size()} right labels over top`)
    labelLogger.info(`corrected ${leftLabelsUnderBottom.size()} left labels under bottom`)
    labelLogger.info(`corrected ${rightLabelsUnderBottom.size()} right labels under bottom`)
    labelLogger.info(`corrected ${labelsOverlappingRightEdgeCount} labels over left`)
    labelLogger.info(`corrected ${labelsOverlappingLeftEdgeCount} labels over right`)
  },

  performInitialClusterSpacing ({
    outerLabelSetSortedTopToBottom,
    innerLabelSet,
    outerRadius,
    maxVerticalOffset,
    canUseInnerLabelsInTheseQuadrants,
    hemisphere,
    pieCenter,
    canvasHeight,
    innerLabelRadius,
    innerRadius,
    outerLabelRadius,
    labelLiftOffAngle,
    horizontalPadding,
    maxAngleBetweenRadialAndLabelLines,
    minGap,
    maxFontSize,
    hasTopLabel,
    hasBottomLabel,
    topIsLifted,
    bottomIsLifted
  }) {
    const upperBoundary = pieCenter.y - outerRadius - maxVerticalOffset + ((hasTopLabel) ? maxFontSize : 0)
    const lowerBoundary = pieCenter.y + outerRadius + maxVerticalOffset - ((hasBottomLabel) ? maxFontSize : 0)

    const getLabelAbove = (label) => {
      const indexOf = outerLabelSetSortedTopToBottom.indexOf(label)
      if (indexOf !== -1 && indexOf !== 0) {
        const labelAbove = outerLabelSetSortedTopToBottom[indexOf - 1]
        // if (labelAbove.topY <= label.topY) { return labelAbove }
        return labelAbove
      }
      return null
    }

    const getLabelBelow = (label) => {
      const indexOf = outerLabelSetSortedTopToBottom.indexOf(label)
      if (indexOf !== -1 && indexOf !== outerLabelSetSortedTopToBottom.length - 1) {
        const labelBelow = outerLabelSetSortedTopToBottom[indexOf + 1]
        // if (labelBelow.bottomY >= label.bottomY) { return labelBelow }
        return labelBelow
      }
      return null
    }

    const pushLabelsUp = (labelsToPushUp) => {
      _(labelsToPushUp).each(labelToPushUp => {
        const labelBelow = getLabelBelow(labelToPushUp)
        if (labelBelow) {
          const newY = labelBelow.topLeftCoord.y - minGap
          if (newY - labelToPushUp.height < upperBoundary) {
            console.warn(`cancelling pushLabelsUp in performInitialClusterSpacing : exceeded upperBoundary`)
            return terminateLoop
          }

          let apexLabelCorrection = 0
          if ((labelToPushUp.topLeftCoord.x < pieCenter.x && hasTopLabel) ||
            (labelToPushUp.topLeftCoord.x > pieCenter.x && hasBottomLabel)) {
            apexLabelCorrection = maxFontSize + minGap
          }

          const oldY = labelToPushUp.bottomLeftCoord.y
          labels.adjustLabelToNewY({
            newY,
            anchor: 'bottom',
            labelRadius: outerLabelRadius,
            yRange: outerRadius + maxVerticalOffset - apexLabelCorrection,
            labelLiftOffAngle,
            labelDatum: labelToPushUp,
            pieCenter,
            horizontalPadding,
            topIsLifted,
            bottomIsLifted
          })

          const angleBetweenRadialAndLabelLinesAfter = labelToPushUp.labelLineAngle
          if (angleBetweenRadialAndLabelLinesAfter > maxAngleBetweenRadialAndLabelLines) {
            labelLogger.info(`cancelling pushLabelsUp in performInitialClusterSpacing : exceeded max angle threshold. OldY: ${oldY}`)
            labels.adjustLabelToNewY({
              newY: oldY,
              anchor: 'bottom',
              labelRadius: outerLabelRadius,
              yRange: outerRadius + maxVerticalOffset - apexLabelCorrection,
              labelLiftOffAngle,
              labelDatum: labelToPushUp,
              pieCenter,
              horizontalPadding,
              topIsLifted,
              bottomIsLifted
            })
            return terminateLoop
          }
        } else {
          console.warn(`tried to push label '${labelToPushUp.label}' up, but there was no label below`)
        }
        return continueLoop
      })
    }

    const pushLabelsDown = (labelsToPushDown) => {
      _(labelsToPushDown).each(labelToPushDown => {
        const labelAbove = getLabelAbove(labelToPushDown)

        if (labelAbove) {
          const newY = labelAbove.bottomLeftCoord.y + minGap
          if (newY + labelToPushDown.height > lowerBoundary) {
            console.warn(`cancelling pushLabelsDown in performInitialClusterSpacing : exceeded lowerBoundary`)
            return terminateLoop
          }

          let apexLabelCorrection = 0
          if ((labelToPushDown.topLeftCoord.x < pieCenter.x && hasTopLabel) ||
            (labelToPushDown.topLeftCoord.x > pieCenter.x && hasBottomLabel)) {
            apexLabelCorrection = maxFontSize + minGap
          }

          const oldY = labelToPushDown.topLeftCoord.y
          labels.adjustLabelToNewY({
            newY,
            anchor: 'top',
            labelRadius: outerLabelRadius,
            yRange: outerRadius + maxVerticalOffset - apexLabelCorrection,
            labelLiftOffAngle,
            labelDatum: labelToPushDown,
            pieCenter,
            horizontalPadding,
            topIsLifted,
            bottomIsLifted
          })

          const angleBetweenRadialAndLabelLinesAfter = labelToPushDown.labelLineAngle
          if (angleBetweenRadialAndLabelLinesAfter > maxAngleBetweenRadialAndLabelLines) {
            labelLogger.debug(`cancelling pushLabelsDown in performInitialClusterSpacing : exceeded max angle threshold`)
            labels.adjustLabelToNewY({
              newY: oldY,
              anchor: 'top',
              labelRadius: outerLabelRadius,
              yRange: outerRadius + maxVerticalOffset - apexLabelCorrection,
              labelLiftOffAngle,
              labelDatum: labelToPushDown,
              pieCenter,
              horizontalPadding,
              topIsLifted,
              bottomIsLifted
            })
            return terminateLoop
          }
        } else {
          console.warn(`tried to push label '${labelToPushDown.label}' down, but there was no label above`)
        }
        return continueLoop
      })
    }

    const collidingLabels = findIntersectingLabels(outerLabelSetSortedTopToBottom)
    const collidingLabelSets = []
    let activeSet = []
    _(collidingLabels).each(collidingLabel => {
      if (activeSet.length === 0) { activeSet.push(collidingLabel); return true }
      if (Math.abs(collidingLabel.id - activeSet[activeSet.length - 1].id) <= 1) {
        activeSet.push(collidingLabel)
      } else {
        collidingLabelSets.push(activeSet)
        activeSet = [collidingLabel]
      }
    })
    if (activeSet.length) {
      collidingLabelSets.push(activeSet)
    }

    _(collidingLabelSets).each(collidingLabelSet => {
      let verticalSpaceAbove = 0
      const nearestNonIntersectingLabelAbove = getLabelAbove(_.first(collidingLabelSet))
      if (nearestNonIntersectingLabelAbove) {
        verticalSpaceAbove = collidingLabelSet[0].topLeftCoord.y - nearestNonIntersectingLabelAbove.bottomLeftCoord.y
      }

      let verticalSpaceBelow = 0
      const nearestNonIntersectingLabelBelow = getLabelBelow(_.last(collidingLabelSet))
      if (nearestNonIntersectingLabelBelow) {
        verticalSpaceBelow = nearestNonIntersectingLabelBelow.topLeftCoord.y - collidingLabelSet[collidingLabelSet.length - 1].bottomLeftCoord.y
      }

      labelLogger.debug(`collidingLabelSet: ${collidingLabelSet.map(label => label.label).join(', ')}`)
      labelLogger.debug(`verticalSpaceAbove: ${verticalSpaceAbove} : verticalSpaceBelow: ${verticalSpaceBelow}`)

      let differenceInVerticalSpace = Math.abs(verticalSpaceBelow - verticalSpaceAbove)
      let sumOfVerticalSpace = verticalSpaceBelow + verticalSpaceAbove
      if (sumOfVerticalSpace > 10 && differenceInVerticalSpace > 10 && verticalSpaceAbove > verticalSpaceBelow) {
        labelLogger.debug(`pushing whole set up`)
        pushLabelsUp(_.reverse(collidingLabelSet))
      } else if (sumOfVerticalSpace > 10 && differenceInVerticalSpace > 10 && verticalSpaceBelow > verticalSpaceAbove) {
        labelLogger.debug(`pushing whole set down`)
        pushLabelsDown(collidingLabelSet)
      } else if (sumOfVerticalSpace > 10) {
        labelLogger.debug(`pushing 1/2 up and 1/2 down`)
        const [labelsToPushUp, labelsToPushDown] = _.chunk(collidingLabelSet, Math.ceil(collidingLabelSet.length / 2))
        pushLabelsUp(_.reverse(labelsToPushUp))
        pushLabelsDown(labelsToPushDown)
      } else {
        labelLogger.debug(`no room to space cluster. Skipping`)
      }
    })
  },

  performTwoPhaseLabelAdjustment ({
    pie,
    stages,
    outerLabelSet,
    innerLabelSet,
    outerRadius,
    maxVerticalOffset,
    canUseInnerLabelsInTheseQuadrants,
    hemisphere,
    pieCenter,
    canvasHeight,
    innerLabelRadius,
    innerRadius,
    outerLabelRadius,
    labelLiftOffAngle,
    horizontalPadding,
    maxAngleBetweenRadialAndLabelLines,
    minGap,
    maxFontSize,
    hasTopLabel,
    hasBottomLabel,
    topIsLifted,
    bottomIsLifted
  }) {
    /*
     Phase 1: push labels down
     For each label moving vertically down the hemisphere
       if it intersects with next neighbor
         then adjust all labels below so they dont intersect.
         During the adjustment if we hit the bottom of the canvas while adjusting, then completely terminate phase 1 and move to phase 2

     Phase 2: push labels up
        if phase 1 was cancelled, then start at the bottom and push labels up
          this should never run out of space because the font sizes of the labels have already been balanced so sum(fontheight) < canvasHeight

     Notes:
       * As soon as we have moved _a single label_ we must reposition the X coord of all labels
       * If at any point a label that has been adjusted has an between the radialLine and the labelLine that exceeds maxAngleBetweenRadialAndLabelLines,
         then throw an interrupt and exit the function
    */

    // NB fundamental for understanding : _.each iterations are cancelled if the fn returns false
    let downSweepHitBottom = false
    let downSweepLineAngleExceeded = false

    let lp = `${hemisphere}:DOWN` // lp = logPrefix
    const inBounds = (candidateIndex, arrayLength = outerLabelSet.length) => candidateIndex >= 0 && candidateIndex < arrayLength
    const isLast = (candidateIndex, arrayLength = outerLabelSet.length) => candidateIndex === arrayLength - 1

    const getPreviousShownLabel = (labelSet, startingIndex) => {
      while (startingIndex - 1 >= 0) {
        if (labelSet[startingIndex - 1].labelShown) { return labelSet[startingIndex - 1] }
        startingIndex--
      }
      return null
    }

    const upperBoundary = pieCenter.y - outerRadius - maxVerticalOffset + ((hasTopLabel) ? maxFontSize : 0)
    const lowerBoundary = pieCenter.y + outerRadius + maxVerticalOffset - ((hasBottomLabel) ? maxFontSize : 0)

    if (stages.downSweep) {
      labelLogger.debug(`${lp} start. Size ${outerLabelSet.length}`)
      _(outerLabelSet).each((frontierLabel, frontierIndex) => {
        labelLogger.debug(`${lp} frontier: ${pl(frontierLabel)}`)
        if (downSweepHitBottom) { labelLogger.debug(`${lp} cancelled`); return terminateLoop }
        if (downSweepLineAngleExceeded) { labelLogger.debug(`${lp} cancelled`); return terminateLoop }
        if (isLast(frontierIndex)) { return terminateLoop }
        if (frontierLabel.hide) { return continueLoop }

        const nextLabel = outerLabelSet[frontierIndex + 1]
        if (nextLabel.hide) { return continueLoop }

        if (frontierLabel.intersectsWith(nextLabel) || nextLabel.isCompletelyAbove(frontierLabel)) {
          labelLogger.debug(` ${lp} intersect ${pl(frontierLabel)} v ${pl(nextLabel)}`)
          _(_.range(frontierIndex + 1, outerLabelSet.length)).each((gettingPushedIndex) => {
            const alreadyAdjustedLabel = getPreviousShownLabel(outerLabelSet, gettingPushedIndex)
            if (!alreadyAdjustedLabel) { return continueLoop }

            const immediatePreviousNeighbor = outerLabelSet[gettingPushedIndex - 1]
            const immediatePreviousNeighborIsInInside = !immediatePreviousNeighbor.labelShown

            const gettingPushedLabel = outerLabelSet[gettingPushedIndex]
            if (gettingPushedLabel.hide) { return continueLoop }

            if (gettingPushedLabel.isBottomApexLabel) {
              labelLogger.debug(`  ${lp} attempt to push ${pl(gettingPushedLabel)} bottom label. cancelling inner`)
              downSweepHitBottom = true
              return continueLoop
            }

            if (downSweepHitBottom) {
              labelLogger.debug(`  ${lp} already hit bottom, placing ${pl(gettingPushedLabel)} at bottom`)
              // we need to place the remaining labels at the bottom so phase 2 will place them as we sweep "up" the hemisphere
              if (gettingPushedLabel.inLeftHalf) {
                gettingPushedLabel.setBottomMedialPoint({ x: pieCenter.x - spacingBetweenUpperTrianglesAndCenterMeridian, y: lowerBoundary })
              } else {
                gettingPushedLabel.setBottomMedialPoint({ x: pieCenter.x + spacingBetweenUpperTrianglesAndCenterMeridian, y: lowerBoundary })
              }
              return continueLoop
            }

            if (gettingPushedLabel.isLowerThan(alreadyAdjustedLabel) && !gettingPushedLabel.intersectsWith(alreadyAdjustedLabel)) {
              labelLogger.debug(`   ${lp} ${pl(alreadyAdjustedLabel)} and ${pl(gettingPushedLabel)} no intersect. cancelling inner`)
              return terminateLoop
            }

            if (canUseInnerLabelsInTheseQuadrants.includes(gettingPushedLabel.segmentQuadrant) && !immediatePreviousNeighborIsInInside) {
              try {
                labels.moveToInnerLabel({
                  label: gettingPushedLabel,
                  innerLabelSet,
                  innerLabelRadius,
                  innerRadius,
                  pieCenter
                })
                return continueLoop
              } catch (error) {
                if (error.isInterrupt && error.type === 'CannotMoveToInner') {
                  labelLogger.debug(`${lp} could not move ${pl(gettingPushedLabel)} to inner: "${error.description}". Proceed with adjustment`)
                } else {
                  throw error
                }
              }
            }

            const newY = alreadyAdjustedLabel.topLeftCoord.y + alreadyAdjustedLabel.height + minGap
            const deltaY = newY - gettingPushedLabel.topLeftCoord.y
            if (newY + gettingPushedLabel.height > lowerBoundary) {
              labelLogger.debug(`  ${lp} pushing ${pl(gettingPushedLabel)} exceeds canvas. placing remaining labels at bottom and cancelling inner`)
              downSweepHitBottom = true

              if (gettingPushedLabel.inLeftHalf) {
                gettingPushedLabel.setBottomMedialPoint({ x: pieCenter.x - spacingBetweenUpperTrianglesAndCenterMeridian, y: lowerBoundary })
              } else {
                gettingPushedLabel.setBottomMedialPoint({ x: pieCenter.x + spacingBetweenUpperTrianglesAndCenterMeridian, y: lowerBoundary })
              }
              return continueLoop
            }

            const angleBetweenRadialAndLabelLinesBefore = gettingPushedLabel.labelLineAngle

            let apexLabelCorrection = 0
            if ((gettingPushedLabel.topLeftCoord.x < pieCenter.x && hasTopLabel) ||
              (gettingPushedLabel.topLeftCoord.x > pieCenter.x && hasBottomLabel)) {
              apexLabelCorrection = maxFontSize + minGap
            }

            labels.adjustLabelToNewY({
              anchor: 'top',
              newY,
              labelRadius: outerLabelRadius,
              yRange: outerRadius + maxVerticalOffset - apexLabelCorrection,
              labelLiftOffAngle,
              labelDatum: gettingPushedLabel,
              pieCenter,
              horizontalPadding,
              topIsLifted,
              bottomIsLifted
            })

            const angleBetweenRadialAndLabelLinesAfter = gettingPushedLabel.labelLineAngle
            labelLogger.debug(`  ${lp} pushing ${pl(gettingPushedLabel)} down by ${deltaY}. Angle before ${angleBetweenRadialAndLabelLinesBefore.toFixed(2)} and after ${angleBetweenRadialAndLabelLinesAfter.toFixed(2)}`)

            if (angleBetweenRadialAndLabelLinesAfter > maxAngleBetweenRadialAndLabelLines) {
              labelLogger.warn(`  ${lp} ${pl(gettingPushedLabel)} line angle exceeds threshold of ${maxAngleBetweenRadialAndLabelLines}. Cancelling downSweep.`)
              downSweepLineAngleExceeded = true
              return terminateLoop
            }

            if (!inBounds(gettingPushedIndex + 1)) { return terminateLoop } // terminate
          })
        }
      })
    }

    if (stages.upSweep && (downSweepHitBottom || downSweepLineAngleExceeded)) {
      // throw away our attempt at inner labelling and start again wrt inner labels!
      // XXX NB TODO strictly speaking we can only throw out our quadrant/hemisphere worth of inner labels
      _(innerLabelSet).each(innerLabel => {
        const matchingOuterLabel = _.find(outerLabelSet, ({ id: outerLabelId }) => outerLabelId === innerLabel.id)
        if (matchingOuterLabel) {
          matchingOuterLabel.labelShown = true
          if (matchingOuterLabel.inLeftHalf) {
            matchingOuterLabel.setBottomMedialPoint({ x: pieCenter.x - spacingBetweenUpperTrianglesAndCenterMeridian, y: lowerBoundary })
          } else {
            matchingOuterLabel.setBottomMedialPoint({ x: pieCenter.x + spacingBetweenUpperTrianglesAndCenterMeridian, y: lowerBoundary })
          }
        } else {
          console.error(`should have found matching outer label for inner label ${pl(innerLabel)}`)
        }
      })
      innerLabelSet.length = 0 // NB must preserve array references !

      // use the original sorted by Y list; when we hit bottom mid algorithm we just placed all the other labels at the bottom, so we can no longer use the label positions for ordering
      const reversedLabelSet = _.reverse(outerLabelSet)
      let lp = `${hemisphere}:UP` // lp = logPrefix
      let phase2HitTop = false

      labelLogger.debug(`${lp} start. Size ${reversedLabelSet.length}`)
      _(reversedLabelSet).each((frontierLabel, frontierIndex) => {
        labelLogger.debug(`${lp} frontier: ${pl(frontierLabel)}`)
        if (phase2HitTop) { labelLogger.debug(`${lp} cancelled`); return terminateLoop }
        if (isLast(frontierIndex)) { return terminateLoop }
        if (frontierLabel.hide) { return continueLoop }

        const nextLabel = reversedLabelSet[frontierIndex + 1]
        if (nextLabel.hide) { return continueLoop }

        if (frontierLabel.intersectsWith(nextLabel) || nextLabel.isCompletelyBelow(frontierLabel)) {
          labelLogger.debug(` ${lp} intersect ${pl(frontierLabel)} v ${pl(nextLabel)}`)
          _(_.range(frontierIndex + 1, reversedLabelSet.length)).each((gettingPushedIndex) => {
            const alreadyAdjustedLabel = getPreviousShownLabel(reversedLabelSet, gettingPushedIndex)
            if (!alreadyAdjustedLabel) { return continueLoop }

            const immediatePreviousNeighbor = reversedLabelSet[gettingPushedIndex - 1]
            const immediatePreviousNeighborIsInInside = !immediatePreviousNeighbor.labelShown

            const gettingPushedLabel = reversedLabelSet[gettingPushedIndex]
            if (gettingPushedLabel.hide) { return continueLoop }

            if (gettingPushedLabel.isTopApexLabel) {
              labelLogger.debug(`  ${lp} attempt to push ${pl(gettingPushedLabel)} top label. cancelling inner`)
              phase2HitTop = true
              return terminateLoop
            }

            if (gettingPushedLabel.isHigherThan(alreadyAdjustedLabel) && !gettingPushedLabel.intersectsWith(alreadyAdjustedLabel)) {
              labelLogger.debug(`   ${lp} ${pl(alreadyAdjustedLabel)} and ${pl(gettingPushedLabel)} no intersect. cancelling inner`)
              return terminateLoop
            }

            if (canUseInnerLabelsInTheseQuadrants.includes(gettingPushedLabel.segmentQuadrant) && !immediatePreviousNeighborIsInInside) {
              try {
                labels.moveToInnerLabel({
                  label: gettingPushedLabel,
                  innerLabelSet,
                  innerLabelRadius,
                  innerRadius,
                  pieCenter
                })
                return continueLoop
              } catch (error) {
                if (error.isInterrupt && error.type === 'CannotMoveToInner') {
                  labelLogger.debug(`${lp} could not move ${pl(gettingPushedLabel)} to inner: "${error.description}". Proceed with adjustment`)
                } else {
                  throw error
                }
              }
            }

            const newY = alreadyAdjustedLabel.topLeftCoord.y - (gettingPushedLabel.height + minGap)
            const deltaY = gettingPushedLabel.topLeftCoord.y - newY
            if (newY < upperBoundary) {
              labelLogger.debug(`  ${lp} pushing ${pl(gettingPushedLabel)} exceeds canvas. cancelling inner`)
              phase2HitTop = true
              // return terminateLoop
              throw new LabelPushedOffCanvas(gettingPushedLabel, 'pushed off top')
            }

            const angleBetweenRadialAndLabelLinesBefore = gettingPushedLabel.labelLineAngle

            let apexLabelCorrection = 0
            if ((gettingPushedLabel.topLeftCoord.x < pieCenter.x && hasTopLabel) ||
              (gettingPushedLabel.topLeftCoord.x > pieCenter.x && hasBottomLabel)) {
              apexLabelCorrection = maxFontSize + minGap
            }

            labels.adjustLabelToNewY({
              anchor: 'top',
              newY,
              labelRadius: outerLabelRadius,
              yRange: outerRadius + maxVerticalOffset - apexLabelCorrection,
              labelLiftOffAngle,
              labelDatum: gettingPushedLabel,
              pieCenter,
              horizontalPadding,
              topIsLifted,
              bottomIsLifted
            })

            const angleBetweenRadialAndLabelLinesAfter = gettingPushedLabel.labelLineAngle

            labelLogger.debug(`  ${lp} pushing ${pl(gettingPushedLabel)} up by ${deltaY}. Angle before ${angleBetweenRadialAndLabelLinesBefore.toFixed(2)} and after ${angleBetweenRadialAndLabelLinesAfter.toFixed(2)}`)

            if (angleBetweenRadialAndLabelLinesAfter > maxAngleBetweenRadialAndLabelLines) {
              throw new AngleThresholdExceeded(gettingPushedLabel, `${angleBetweenRadialAndLabelLinesAfter} > ${maxAngleBetweenRadialAndLabelLines}`)
            }

            if (!inBounds(gettingPushedIndex + 1)) { return terminateLoop }
          })
        }
      })
    }

    if (stages.finalPass) {
      // final check for left over line angle violators
      _(outerLabelSet).each(label => {
        const angleBetweenRadialAndLabelLine = label.labelLineAngle
        if (angleBetweenRadialAndLabelLine > maxAngleBetweenRadialAndLabelLines) {
          labelLogger.warn(`  final pass found ${pl(label)} line angle exceeds threshold.`)
          throw new AngleThresholdExceeded(label, `${angleBetweenRadialAndLabelLine} > ${maxAngleBetweenRadialAndLabelLines}`)
        }
      })

      // final check for colliding labels
      const collidingLabels = findIntersectingLabels(outerLabelSet)
      if (collidingLabels.length > 0) {
        labelLogger.warn(`  final pass found ${collidingLabels.length} colliding labels.`)
        throw new LabelCollision(collidingLabels[0], 'final check after up sweep')
      }
    }
  },

  shortenTopAndBottom (pie) {
    this.shortenLiftedTopLabels(pie)
    this.shortenTopLabel(pie)
    this.shortenLiftedBottomLabels(pie)
    this.shortenBottomLabel(pie)
  },

  shortenLiftedTopLabels (pie) {
    if (!pie.topIsLifted || !pie.options.labels.stages.shortenTopAndBottom) {
      return
    }

    try {
      const labelPadding = parseFloat(pie.options.labels.outer.outerPadding)
      const outerRadiusYCoord = pie.pieCenter.y - pie.outerRadius
      const baseLabelOffsetYCoord = pie.pieCenter.y - pie.outerRadius - pie.labelOffset
      const labelMaxLineAngle = parseFloat(pie.options.labels.outer.labelMaxLineAngle)

      const maxVerticalOffset = (pie.hasTopLabel)
        ? pie.maxVerticalOffset - pie.maxFontSize - labelPadding
        : pie.maxVerticalOffset
      const maxVerticalOffsetYValue = outerRadiusYCoord - maxVerticalOffset

      const pointAtZeroDegreesAlongLabelOffset = {
        x: pie.pieCenter.x - pie.outerRadius - pie.labelOffset,
        y: pie.pieCenter.y
      }
      const labelLiftOffAngle = parseFloat(pie.options.labels.outer.liftOffAngle)

      // NB TODO move leftPointWhereTriangleMeetsLabelRadius into set facts
      const leftPointWhereTriangleMeetsLabelRadius = rotate(pointAtZeroDegreesAlongLabelOffset, pie.pieCenter, 90 - labelLiftOffAngle)
      const rightPointWhereTriangleMeetsLabelRadius = rotate(pointAtZeroDegreesAlongLabelOffset, pie.pieCenter, 90 + labelLiftOffAngle)

      // TODO can I add this cloneDeep in the chain ?
      const setsSortedVerticallyOutward = {
        left: _.cloneDeep(_(pie.outerLabelData)
          .filter('isLifted')
          .filter('inLeftHalf')
          .filter(({ topY }) => topY <= leftPointWhereTriangleMeetsLabelRadius.y)
          .filter(({ isTopApexLabel }) => !isTopApexLabel)
          .sortBy([({ lineConnectorCoord }) => { return -1 * lineConnectorCoord.y }, ({ id }) => { return -1 * id }])
          .value()),
        right: _.cloneDeep(_(pie.outerLabelData)
          .filter('isLifted')
          .filter('inRightHalf')
          .filter(({ topY }) => topY <= rightPointWhereTriangleMeetsLabelRadius.y)
          .filter(({ isTopApexLabel }) => !isTopApexLabel)
          .sortBy([({ lineConnectorCoord }) => { return -1 * lineConnectorCoord.y }, ({ id }) => { return -1 * id }])
          .value())
      }

      const setFacts = {
        left: {
          length: setsSortedVerticallyOutward.left.length,
          totalHeight: _(setsSortedVerticallyOutward.left).map('height').sum(),
          originalLineConnectorCoords: _(setsSortedVerticallyOutward.left).map('lineConnectorCoord').value(),
          nearestNeighborInwards: labels.nearestNeighborBelow(pie, setsSortedVerticallyOutward.left[0])
        },
        right: {
          length: setsSortedVerticallyOutward.right.length,
          totalHeight: _(setsSortedVerticallyOutward.right).map('height').sum(),
          originalLineConnectorCoords: _(setsSortedVerticallyOutward.right).map('lineConnectorCoord').value(),
          nearestNeighborInwards: labels.nearestNeighborBelow(pie, setsSortedVerticallyOutward.right[0])
        }
      }

      setFacts.left.idealStartingPoint = _([
        leftPointWhereTriangleMeetsLabelRadius.y,
        (setFacts.left.nearestNeighborInwards) ? setFacts.left.nearestNeighborInwards.topY : null
      ])
        .filter(x => !_.isNull(x))
        .filter(x => !_.isUndefined(x))
        .min()

      setFacts.right.idealStartingPoint = _([
        rightPointWhereTriangleMeetsLabelRadius.y,
        (setFacts.right.nearestNeighborInwards) ? setFacts.right.nearestNeighborInwards.topY : null
      ])
        .filter(x => !_.isNull(x))
        .filter(x => !_.isUndefined(x))
        .min()

      const idealLabelPadding = 2

      // TODO setFacts.left.simpleWorked has not been set yet so it can be removed from conditionals below
      // unless this is called iteratively ?
      const newApexYCoord = _([
        (_.isEmpty(setsSortedVerticallyOutward.left) || setFacts.left.simpleWorked) ? null : setFacts.left.idealStartingPoint - setFacts.left.totalHeight - (setFacts.left.length) * idealLabelPadding,
        (_.isEmpty(setsSortedVerticallyOutward.right) || setFacts.right.simpleWorked) ? null : setFacts.right.idealStartingPoint - setFacts.right.totalHeight - (setFacts.right.length) * idealLabelPadding,
        baseLabelOffsetYCoord // ensure a minimum amount of lift
      ])
        .filter(x => !_.isNull(x))
        .filter(x => !_.isUndefined(x))
        .min()

      if (newApexYCoord < maxVerticalOffsetYValue) {
        labelLogger.info(`not enough free vertical space to shorten. aborting shorten top`)
        return
      }

      if (setFacts.left.length === 0) {
        labelLogger.info(`shorten top: 0 left labels, skipping`)
      } else {
        // first try to just place them on the labelOffsetRadius, and only proceed to more complex steps below if collisions are detected
        _(setsSortedVerticallyOutward.left).each(label => {
          labels.placeLabelAlongLabelRadiusWithLiftOffAngle({
            labelDatum: label,
            labelOffset: pie.labelOffset,
            labelLiftOffAngle: 0, // NB note the 0 lift off angle (this fn is effectively "place along radius")
            outerRadius: pie.outerRadius,
            pieCenter: pie.pieCenter,
            canvasHeight: parseFloat(pie.options.size.canvasHeight),
            maxFontSize: pie.maxFontSize,
            maxVerticalOffset: pie.maxVerticalOffset,
            hasTopLabel: pie.hasTopLabel,
            hasBottomLabel: pie.hasBottomLabel,
            minGap: parseFloat(pie.options.labels.outer.outerPadding)
          })
        })

        const collisions = findIntersectingLabels([setFacts.left.nearestNeighborInwards].concat(setsSortedVerticallyOutward.left))
        let labelsExceedingMaxLineAngleCount = exceedsLabelLineAngleThresholdCount({
          labels: setsSortedVerticallyOutward.left, threshold: labelMaxLineAngle
        })
        if (collisions.length === 0 && labelsExceedingMaxLineAngleCount === 0) {
          setFacts.left.simpleWorked = true
          labelLogger.info(`shorten top: placing left labels along label offset radius worked`)
        } else {
          labelLogger.info(`shorten top: placing left labels along label offset radius did not work. Proceeding with spacing along new lift triangle`)
          _(setsSortedVerticallyOutward.left).each((label, index) => {
            label.placeLabelViaConnectorCoord(setFacts.left.originalLineConnectorCoords[index])
          })
          setFacts.left.simpleWorked = false
        }

        // if simple didn't work proceed with more complicated solution
        if (!setFacts.left.simpleWorked) {
          const leftPlacementTriangleLine = [
            leftPointWhereTriangleMeetsLabelRadius,
            { x: pie.pieCenter.x - spacingBetweenUpperTrianglesAndCenterMeridian, y: newApexYCoord }
          ]

          const availableVerticalSpace = setFacts.left.idealStartingPoint - newApexYCoord
          let newLabelPadding = (availableVerticalSpace - setFacts.left.totalHeight) / setFacts.left.length
          let leftFrontierYCoord = setFacts.left.idealStartingPoint - newLabelPadding
          _(setsSortedVerticallyOutward.left).each((label, index) => {
            const newLineConnectorY = leftFrontierYCoord - label.lineConnectorOffsetFromBottom
            const newLineConnectorLatitude = [
              { x: 0, y: newLineConnectorY },
              { x: parseFloat(pie.options.size.canvasWidth), y: newLineConnectorY }
            ]
            const intersection = computeIntersection(leftPlacementTriangleLine, newLineConnectorLatitude)
            if (intersection) {
              labelLogger.debug(`shorten top: left side: placing ${pl(label)} lineConnector at x:${intersection.x}, y: ${newLineConnectorY}`)
              label.placeLabelViaConnectorCoord({
                x: intersection.x,
                y: newLineConnectorY
              })
              leftFrontierYCoord = label.topY - newLabelPadding
            } else {
              labelLogger.error(`unexpected condition. could not compute intersection with new placementTriangleLine and newLineConnectorLatitude for ${pl(label)}`)
            }
          })
        }

        labelsExceedingMaxLineAngleCount = exceedsLabelLineAngleThresholdCount({
          labels: setsSortedVerticallyOutward.left, threshold: labelMaxLineAngle
        })
        if (labelsExceedingMaxLineAngleCount > 0) {
          labelLogger.info(`shorten top: left side: labelLineAngle exceeded. Aborting`)
          return
        }

        // getting here means success ! Apply the cloned labels back to the mainline
        _(setsSortedVerticallyOutward.left).each(clonedLabel => {
          const index = _.findIndex(pie.outerLabelData, { id: clonedLabel.id })
          if (index !== -1) {
            pie.outerLabelData[index] = clonedLabel
          }
        })
      }

      if (setFacts.right.length === 0) {
        labelLogger.info(`shorten top: 0 right labels, skipping`)
      } else {
        // first try to just place them on the labelOffsetRadius, and only proceed to more complex steps below if collisions are detected
        _(setsSortedVerticallyOutward.right).each(label => {
          labels.placeLabelAlongLabelRadiusWithLiftOffAngle({
            labelDatum: label,
            labelOffset: pie.labelOffset,
            labelLiftOffAngle: 0,
            outerRadius: pie.outerRadius,
            pieCenter: pie.pieCenter,
            canvasHeight: parseFloat(pie.options.size.canvasHeight),
            maxFontSize: pie.maxFontSize,
            maxVerticalOffset: pie.maxVerticalOffset,
            hasTopLabel: pie.hasTopLabel,
            hasBottomLabel: pie.hasBottomLabel,
            minGap: parseFloat(pie.options.labels.outer.outerPadding)
          })
        })

        const collisions = findIntersectingLabels([setFacts.right.nearestNeighborInwards].concat(setsSortedVerticallyOutward.right))
        let labelsExceedingMaxLineAngleCount = exceedsLabelLineAngleThresholdCount({
          labels: setsSortedVerticallyOutward.right, threshold: labelMaxLineAngle
        })
        if (collisions.length === 0 && labelsExceedingMaxLineAngleCount === 0) {
          setFacts.right.simpleWorked = true
          labelLogger.info(`shorten top: placing right labels along label offset radius worked`)
        } else {
          labelLogger.info(`shorten top: placing right labels along label offset radius did not work. Proceeding with spacing along new lift triangle`)
          _(setsSortedVerticallyOutward.right).each((label, index) => {
            label.placeLabelViaConnectorCoord(setFacts.right.originalLineConnectorCoords[index])
          })
          setFacts.right.simpleWorked = false
        }

        // if simple didn't work proceed with more complicated solution
        if (!setFacts.right.simpleWorked) {
          const rightPlacementTriangleLine = [
            rightPointWhereTriangleMeetsLabelRadius,
            { x: pie.pieCenter.x + spacingBetweenUpperTrianglesAndCenterMeridian, y: newApexYCoord }
          ]

          const availableVerticalSpace = setFacts.right.idealStartingPoint - newApexYCoord
          let newLabelPadding = (availableVerticalSpace - setFacts.right.totalHeight) / setFacts.right.length
          let rightFrontierYCoord = setFacts.right.idealStartingPoint - newLabelPadding
          _(setsSortedVerticallyOutward.right).each((label, index) => {
            const newLineConnectorY = rightFrontierYCoord - label.lineConnectorOffsetFromBottom
            const newLineConnectorLatitude = [
              { x: 0, y: newLineConnectorY },
              { x: parseFloat(pie.options.size.canvasWidth), y: newLineConnectorY }
            ]
            const intersection = computeIntersection(rightPlacementTriangleLine, newLineConnectorLatitude)
            if (intersection) {
              labelLogger.debug(`shorten top: right side: placing ${pl(label)} lineConnector at x:${intersection.x}, y: ${newLineConnectorY}`)
              label.placeLabelViaConnectorCoord({
                x: intersection.x,
                y: newLineConnectorY
              })
              rightFrontierYCoord = label.topY - newLabelPadding
            } else {
              labelLogger.error(`unexpected condition. could not compute intersection with new placementTriangleLine and newLineConnectorLatitude for ${pl(label)}`)
            }
          })
        }

        labelsExceedingMaxLineAngleCount = exceedsLabelLineAngleThresholdCount({
          labels: setsSortedVerticallyOutward.right, threshold: labelMaxLineAngle
        })
        if (labelsExceedingMaxLineAngleCount > 0) {
          labelLogger.info(`shorten top: right side: labelLineAngle exceeded. Aborting`)
          return
        }

        // getting here means success ! Apply the cloned labels back to the mainline
        _(setsSortedVerticallyOutward.right).each(clonedLabel => {
          const index = _.findIndex(pie.outerLabelData, { id: clonedLabel.id })
          if (index !== -1) {
            pie.outerLabelData[index] = clonedLabel
          }
        })
      }
    } catch (error) {
      console.error(error)
    }
  },

  shortenTopLabel (pie) {
    const topLabel = _(pie.outerLabelData).find('isTopApexLabel')
    if (topLabel) {
      const topLabelIndex = pie.outerLabelData.indexOf(topLabel)
      const nearestNeighbors = []
      if (topLabelIndex > 0) { nearestNeighbors.push(pie.outerLabelData[topLabelIndex - 1]) }
      if (topLabelIndex < pie.outerLabelData.length - 1) { nearestNeighbors.push(pie.outerLabelData[topLabelIndex + 1]) }
      const topYOfNearestLabel = _(nearestNeighbors).map('topLeftCoord.y').min()

      const newBottomYCoord = _.min([
        topYOfNearestLabel - parseFloat(pie.options.labels.outer.outerPadding),
        pie.pieCenter.y - pie.outerRadius - pie.labelOffset
      ])

      if (newBottomYCoord > topLabel.bottomLeftCoord.y) {
        topLabel.placeLabelViaConnectorCoord({ x: topLabel.lineConnectorCoord.x, y: newBottomYCoord })
      }
    }
  },

  shortenLiftedBottomLabels (pie) {
    if (!pie.bottomIsLifted || !pie.options.labels.stages.shortenTopAndBottom) {
      return
    }

    try {
      const labelPadding = parseFloat(pie.options.labels.outer.outerPadding)
      const outerRadiusYCoord = pie.pieCenter.y + pie.outerRadius
      const baseLabelOffsetYCoord = pie.pieCenter.y + pie.outerRadius + pie.labelOffset
      const labelMaxLineAngle = parseFloat(pie.options.labels.outer.labelMaxLineAngle)

      const maxVerticalOffset = (pie.hasBottomLabel)
        ? pie.maxVerticalOffset - pie.maxFontSize - labelPadding
        : pie.maxVerticalOffset
      const maxVerticalOffsetYValue = outerRadiusYCoord + maxVerticalOffset

      const pointAtZeroDegreesAlongLabelOffset = {
        x: pie.pieCenter.x - pie.outerRadius - pie.labelOffset,
        y: pie.pieCenter.y
      }
      const labelLiftOffAngle = parseFloat(pie.options.labels.outer.liftOffAngle)
      const leftPointWhereTriangleMeetsLabelRadius = rotate(pointAtZeroDegreesAlongLabelOffset, pie.pieCenter, 270 + labelLiftOffAngle)
      const rightPointWhereTriangleMeetsLabelRadius = rotate(pointAtZeroDegreesAlongLabelOffset, pie.pieCenter, 270 - labelLiftOffAngle)

      // TODO can I add this cloneDeep in the chain ?
      const setsSortedVerticallyOutward = {
        left: _.cloneDeep(_(pie.outerLabelData)
          .filter('inLeftHalf')
          .filter('isLifted')
          .filter(({ bottomY }) => bottomY >= leftPointWhereTriangleMeetsLabelRadius.y)
          .filter(({ isBottomApexLabel }) => !isBottomApexLabel)
          .sortBy([({ lineConnectorCoord }) => { return lineConnectorCoord.y }, ({ id }) => { return -1 * id }])
          .value()),
        right: _.cloneDeep(_(pie.outerLabelData)
          .filter('inRightHalf')
          .filter('isLifted')
          .filter(({ bottomY }) => bottomY >= rightPointWhereTriangleMeetsLabelRadius.y)
          .filter(({ isBottomApexLabel }) => !isBottomApexLabel)
          .sortBy([({ lineConnectorCoord }) => { return lineConnectorCoord.y }, ({ id }) => { return -1 * id }])
          .value())
      }

      const setFacts = {
        left: {
          length: setsSortedVerticallyOutward.left.length,
          totalHeight: _(setsSortedVerticallyOutward.left).map('height').sum(),
          originalLineConnectorCoords: _(setsSortedVerticallyOutward.left).map('lineConnectorCoord').value(),
          nearestNeighborInwards: labels.nearestNeighborAbove(pie, setsSortedVerticallyOutward.left[0])
        },
        right: {
          length: setsSortedVerticallyOutward.right.length,
          originalLineConnectorCoords: _(setsSortedVerticallyOutward.right).map('lineConnectorCoord').value(),
          totalHeight: _(setsSortedVerticallyOutward.right).map('height').sum(),
          nearestNeighborInwards: labels.nearestNeighborAbove(pie, setsSortedVerticallyOutward.right[0])
        }
      }

      setFacts.left.idealStartingPoint = _([
        leftPointWhereTriangleMeetsLabelRadius.y,
        (setFacts.left.nearestNeighborInwards) ? setFacts.left.nearestNeighborInwards.bottomY : null
      ])
        .filter(x => !_.isNull(x))
        .filter(x => !_.isUndefined(x))
        .max()

      setFacts.right.idealStartingPoint = _([
        rightPointWhereTriangleMeetsLabelRadius.y,
        (setFacts.right.nearestNeighborInwards) ? setFacts.right.nearestNeighborInwards.bottomY : null
      ])
        .filter(x => !_.isNull(x))
        .filter(x => !_.isUndefined(x))
        .max()

      const idealLabelPadding = 2

      const newApexYCoord = _([
        (_.isEmpty(setsSortedVerticallyOutward.left)) ? null : setFacts.left.idealStartingPoint + setFacts.left.totalHeight + (setFacts.left.length) * idealLabelPadding,
        (_.isEmpty(setsSortedVerticallyOutward.right)) ? null : setFacts.right.idealStartingPoint + setFacts.right.totalHeight + (setFacts.right.length) * idealLabelPadding,
        baseLabelOffsetYCoord // ensure a minimum amount of lift
      ])
        .filter(x => !_.isNull(x))
        .filter(x => !_.isUndefined(x))
        .max()

      if (newApexYCoord > maxVerticalOffsetYValue) {
        labelLogger.info(`not enough free vertical space to shorten. aborting shorten top`)
        return
      }

      if (setFacts.left.length === 0) {
        labelLogger.info(`shorten bottom: 0 left labels, skipping`)
      } else {
        // first try to just place them on the labelOffsetRadius, and only proceed to more complex steps below if collisions are detected
        _(setsSortedVerticallyOutward.left).each(label => {
          labels.placeLabelAlongLabelRadiusWithLiftOffAngle({
            labelDatum: label,
            labelOffset: pie.labelOffset,
            labelLiftOffAngle: 0,
            outerRadius: pie.outerRadius,
            pieCenter: pie.pieCenter,
            canvasHeight: parseFloat(pie.options.size.canvasHeight),
            maxFontSize: pie.maxFontSize,
            maxVerticalOffset: pie.maxVerticalOffset,
            hasTopLabel: pie.hasTopLabel,
            hasBottomLabel: pie.hasBottomLabel,
            minGap: parseFloat(pie.options.labels.outer.outerPadding)
          })
        })

        const collisions = findIntersectingLabels([setFacts.left.nearestNeighborInwards].concat(setsSortedVerticallyOutward.left))
        let labelsExceedingMaxLineAngleCount = exceedsLabelLineAngleThresholdCount({
          labels: setsSortedVerticallyOutward.left, threshold: labelMaxLineAngle
        })
        if (collisions.length === 0 && labelsExceedingMaxLineAngleCount === 0) {
          setFacts.left.simpleWorked = true
          labelLogger.info(`shorten bottom: placing left labels along label offset radius worked`)
        } else {
          labelLogger.info(`shorten bottom: placing left labels along label offset radius did not work. Proceeding with spacing along new lift triangle`)
          _(setsSortedVerticallyOutward.left).each((label, index) => {
            label.placeLabelViaConnectorCoord(setFacts.left.originalLineConnectorCoords[index])
          })
          setFacts.left.simpleWorked = false
        }

        // if simple didn't work proceed with more complicated solution
        if (!setFacts.left.simpleWorked) {
          const leftPlacementTriangleLine = [
            leftPointWhereTriangleMeetsLabelRadius,
            { x: pie.pieCenter.x - spacingBetweenUpperTrianglesAndCenterMeridian, y: newApexYCoord }
          ]
          // helpers.showLine(pie.svg, leftPlacementTriangleLine)

          const availableVerticalSpace = newApexYCoord - setFacts.left.idealStartingPoint
          let newlabelPadding = (availableVerticalSpace - setFacts.left.totalHeight) / setFacts.left.length
          let leftFrontierYCoord = setFacts.left.idealStartingPoint + newlabelPadding
          _(setsSortedVerticallyOutward.left).each((label, index) => {
            const newLineConnectorY = leftFrontierYCoord + label.lineConnectorOffsetFromTop
            const newLineConnectorLatitude = [
              { x: 0, y: newLineConnectorY },
              { x: parseFloat(pie.options.size.canvasWidth), y: newLineConnectorY }
            ]
            const intersection = computeIntersection(leftPlacementTriangleLine, newLineConnectorLatitude)
            if (intersection) {
              labelLogger.debug(`shorten bottom: left side: placing ${pl(label)} lineConnector at x:${intersection.x}, y: ${newLineConnectorY}`)
              label.placeLabelViaConnectorCoord({
                x: intersection.x,
                y: newLineConnectorY
              })
              leftFrontierYCoord = label.bottomY + newlabelPadding
            } else {
              labelLogger.error(`unexpected condition. could not compute intersection with new placementTriangleLine and newLineConnectorLatitude for ${pl(label)}`)
            }
          })
        }

        labelsExceedingMaxLineAngleCount = exceedsLabelLineAngleThresholdCount({
          labels: setsSortedVerticallyOutward.left, threshold: labelMaxLineAngle
        })
        if (labelsExceedingMaxLineAngleCount > 0) {
          labelLogger.info(`shorten bottom: left side: labelLineAngle exceeded. Aborting`)
          return
        }

        // getting here means success ! Apply the cloned labels back to the mainline
        _(setsSortedVerticallyOutward.left).each(clonedLabel => {
          const index = _.findIndex(pie.outerLabelData, { id: clonedLabel.id })
          if (index !== -1) {
            pie.outerLabelData[index] = clonedLabel
          }
        })
      }

      if (setFacts.right.length === 0) {
        labelLogger.info(`shorten bottom: 0 right labels, skipping`)
      } else {
        // first try to just place them on the labelOffsetRadius, and only proceed to more complex steps below if collisions are detected
        _(setsSortedVerticallyOutward.right).each(label => {
          labels.placeLabelAlongLabelRadiusWithLiftOffAngle({
            labelDatum: label,
            labelOffset: pie.labelOffset,
            labelLiftOffAngle: 0,
            outerRadius: pie.outerRadius,
            pieCenter: pie.pieCenter,
            canvasHeight: parseFloat(pie.options.size.canvasHeight),
            maxFontSize: pie.maxFontSize,
            maxVerticalOffset: pie.maxVerticalOffset,
            hasTopLabel: pie.hasTopLabel,
            hasBottomLabel: pie.hasBottomLabel,
            minGap: parseFloat(pie.options.labels.outer.outerPadding)
          })
        })

        const collisions = findIntersectingLabels([setFacts.right.nearestNeighborInwards].concat(setsSortedVerticallyOutward.right))
        let labelsExceedingMaxLineAngleCount = exceedsLabelLineAngleThresholdCount({
          labels: setsSortedVerticallyOutward.right, threshold: labelMaxLineAngle
        })
        if (collisions.length === 0 && labelsExceedingMaxLineAngleCount === 0) {
          setFacts.right.simpleWorked = true
          labelLogger.info(`shorten bottom: placing right labels along label offset radius worked`)
        } else {
          labelLogger.info(`shorten bottom: placing right labels along label offset radius did not work. Proceeding with spacing along new lift triangle`)
          _(setsSortedVerticallyOutward.right).each((label, index) => {
            label.placeLabelViaConnectorCoord(setFacts.right.originalLineConnectorCoords[index])
          })
          setFacts.right.simpleWorked = false
        }

        // if simple didn't work proceed with more complicated solution
        if (!setFacts.right.simpleWorked) {
          const rightPlacementTriangleLine = [
            rightPointWhereTriangleMeetsLabelRadius,
            { x: pie.pieCenter.x + spacingBetweenUpperTrianglesAndCenterMeridian, y: newApexYCoord }
          ]
          // helpers.showLine(pie.svg, rightPlacementTriangleLine)

          const availableVerticalSpace = newApexYCoord - setFacts.right.idealStartingPoint
          let newLabelPadding = (availableVerticalSpace - setFacts.right.totalHeight) / setFacts.right.length
          let rightFrontierYCoord = setFacts.right.idealStartingPoint + newLabelPadding
          _(setsSortedVerticallyOutward.right).each((label, index) => {
            const newLineConnectorY = rightFrontierYCoord + label.lineConnectorOffsetFromTop
            const newLineConnectorLatitude = [
              { x: 0, y: newLineConnectorY },
              { x: parseFloat(pie.options.size.canvasWidth), y: newLineConnectorY }
            ]
            const intersection = computeIntersection(rightPlacementTriangleLine, newLineConnectorLatitude)
            if (intersection) {
              labelLogger.debug(`shorten bottom: right side: placing ${pl(label)} lineConnector at x:${intersection.x}, y: ${newLineConnectorY}`)
              label.placeLabelViaConnectorCoord({
                x: intersection.x,
                y: newLineConnectorY
              })
              rightFrontierYCoord = label.bottomY + newLabelPadding
            } else {
              labelLogger.error(`unexpected condition. could not compute intersection with new placementTriangleLine and newLineConnectorLatitude for ${pl(label)}`)
            }
          })
        }

        labelsExceedingMaxLineAngleCount = exceedsLabelLineAngleThresholdCount({
          labels: setsSortedVerticallyOutward.right, threshold: labelMaxLineAngle
        })
        if (labelsExceedingMaxLineAngleCount > 0) {
          labelLogger.info(`shorten bottom: right side: labelLineAngle exceeded. Aborting`)
          return
        }

        // getting here means success ! Apply the cloned labels back to the mainline
        _(setsSortedVerticallyOutward.right).each(clonedLabel => {
          const index = _.findIndex(pie.outerLabelData, { id: clonedLabel.id })
          if (index !== -1) {
            pie.outerLabelData[index] = clonedLabel
          }
        })
      }
    } catch (error) {
      console.error(error.stack)
    }
  },

  shortenBottomLabel (pie) {
    const bottomLabel = _(pie.outerLabelData).find('isBottomApexLabel')
    if (bottomLabel) {
      const bottomLabelIndex = pie.outerLabelData.indexOf(bottomLabel)
      const nearestNeighbors = []
      if (bottomLabelIndex > 0) { nearestNeighbors.push(pie.outerLabelData[bottomLabelIndex - 1]) }
      if (bottomLabelIndex < pie.outerLabelData.length - 1) { nearestNeighbors.push(pie.outerLabelData[bottomLabelIndex + 1]) }
      const bottomYOfNearestLabel = _(nearestNeighbors).map('bottomLeftCoord.y').max()

      const newTopYCoord = _.max([
        bottomYOfNearestLabel + parseFloat(pie.options.labels.outer.outerPadding),
        pie.pieCenter.y + pie.outerRadius + pie.labelOffset
      ])

      if (newTopYCoord < bottomLabel.topLeftCoord.y) {
        bottomLabel.placeLabelViaConnectorCoord({ x: bottomLabel.lineConnectorCoord.x, y: newTopYCoord })
      }
    }
  },

  wrapAndFormatLabelUsingSvgApproximation ({
    parentContainer,
    labelText,
    fontSize,
    fontFamily,
    innerPadding,
    maxLabelWidth,
    maxLabelLines
  }) {
    let lines = splitIntoLines(labelText, maxLabelWidth, fontSize, fontFamily, maxLabelLines)
    const dimensions = lines.map(line => {
      return getLabelDimensionsUsingSvgApproximation(parentContainer, line, fontSize, fontFamily)
    })
    const widestLine = _(dimensions).map('width').max()
    const sumHeightAndPadding = _(dimensions).map('height').sum() + (lines.length - 1) * innerPadding

    return {
      lineHeight: dimensions[0].height,
      width: widestLine,
      height: sumHeightAndPadding,
      labelTextLines: lines
    }
  },

  buildLabelSet: function ({
    labelData,
    totalSize,
    minAngle,
    fontSize,
    fontFamily,
    displayPercentage,
    displayDecimals,
    displayPrefix,
    displaySuffix,
    innerPadding
  }) {
    let cumulativeValue = 0

    return labelData
      .map((datum) => {
        const angleExtent = datum.value * 360 / totalSize
        const angleStart = cumulativeValue * 360 / totalSize
        cumulativeValue += datum.value

        return new OuterLabel({
          segmentAngleMidpoint: angleStart + angleExtent / 2,
          color: datum.color,
          fontFamily,
          fontSize,
          group: datum.group,
          id: datum.id,
          innerPadding,
          label: datum.label,
          totalValue: totalSize,
          value: datum.value,
          displayPercentage,
          displayDecimals,
          displayPrefix,
          displaySuffix
        })
      })
      .filter(({ value }) => { return value / totalSize >= minAngle }) // NB must filter here as we are tracking cumulative value above
  },

  computeLabelStats: function (labelSet, outerlabelPadding = 1) {
    const leftLabels = _(labelSet).filter({ hemisphere: 'left' }).value()
    const rightLabels = _(labelSet).filter({ hemisphere: 'right' }).value()

    const minDataValue = _(labelSet)
      .map('value')
      .min()

    const maxDataValue = _(labelSet)
      .map('value')
      .max()

    let maxLeftSideLabelWidth = _(leftLabels)
      .map('width')
      .max() || 0

    let maxRightSideLabelWidth = _(rightLabels)
      .map('width')
      .max() || 0

    let maxLeftSideLabelHeight = _(leftLabels)
      .map('height')
      .max() || 0

    let maxRightSideLabelHeight = _(rightLabels)
      .map('height')
      .max() || 0

    let cumulativeLeftSideLabelHeight = _(leftLabels)
      .map('height')
      .sum() + outerlabelPadding * Math.max(0, (leftLabels.length - 1))

    let cumulativeRightSideLabelHeight = _(rightLabels)
      .map('height')
      .sum() + outerlabelPadding * Math.max(0, (rightLabels.length - 1))

    let fontSizeDistribution = _(labelSet).countBy('fontSize')

    let maxFontSize = _(labelSet)
      .map('fontSize')
      .max() || 0

    let densities = _(labelSet)
      .countBy(labelDatum => {
        if (between(60, labelDatum.segmentAngleMidpoint, 120)) { return 'top' }
        if (between(240, labelDatum.segmentAngleMidpoint, 300)) { return 'bottom' }
        return 'middle'
      })
      .defaults({ top: 0, middle: 0, bottom: 0 })
      .value()

    return {
      densities,
      maxFontSize,
      fontSizeDistribution, // TODO this is a lodash wrapped object (but it works ?)
      minDataValue,
      maxDataValue,
      maxLeftSideLabelWidth,
      maxRightSideLabelWidth,
      maxLabelWidth: Math.max(maxLeftSideLabelWidth, maxRightSideLabelWidth),
      maxLeftSideLabelHeight,
      maxRightSideLabelHeight,
      maxLabelHeight: Math.max(maxLeftSideLabelHeight, maxRightSideLabelHeight),
      cumulativeLeftSideLabelHeight,
      cumulativeRightSideLabelHeight
    }
  },

  // Current Assumptions / Limitations:
  //   * assuming that inner labels are added in order of fractionalValue descending,
  //       therefore if I cant place the current label, abort, leaving the existing inner labels as is (note this assumption is not valid, but in practice code works fine)
  moveToInnerLabel: function ({
    label,
    innerLabelSet,
    innerLabelRadius,
    innerRadius,
    pieCenter
  }) {
    const newInnerLabel = InnerLabel.fromOuterLabel(label)
    newInnerLabel.innerLabelRadius = innerLabelRadius
    newInnerLabel.innerRadius = innerRadius
    newInnerLabel.pieCenter = pieCenter
    const coordAtZeroDegreesAlongInnerPieDistance = {
      x: pieCenter.x - innerLabelRadius,
      y: pieCenter.y
    }

    const innerRadiusLabelCoord = rotate(coordAtZeroDegreesAlongInnerPieDistance, pieCenter, label.segmentAngleMidpoint)
    newInnerLabel.placeAlongFitLine(innerRadiusLabelCoord)

    if (!_.isEmpty(innerLabelSet)) {
      const previousLabel = _.last(innerLabelSet)

      const rightHemiAndNewShouldBeLower = (newInnerLabel.hemisphere === 'right' && newInnerLabel.segmentAngleMidpoint > previousLabel.segmentAngleMidpoint)
      const topLeftHemiAndNewShouldBeLower = (newInnerLabel.hemisphere === 'left' && between(0, newInnerLabel.segmentAngleMidpoint, 90) && newInnerLabel.segmentAngleMidpoint < previousLabel.segmentAngleMidpoint)
      const bottomLeftHemiAndNewShouldBeLower = (newInnerLabel.hemisphere === 'left' && between(270, newInnerLabel.segmentAngleMidpoint, 360) && newInnerLabel.segmentAngleMidpoint < previousLabel.segmentAngleMidpoint)

      // ignore cross hemispheres
      const newLabelShouldBeBelowPreviousLabel = (
        rightHemiAndNewShouldBeLower ||
        topLeftHemiAndNewShouldBeLower ||
        bottomLeftHemiAndNewShouldBeLower
      )

      const newLabelIsInOrderVertically = (newLabelShouldBeBelowPreviousLabel)
        ? newInnerLabel.isLowerThan(previousLabel)
        : newInnerLabel.isHigherThan(previousLabel)

      if (newInnerLabel.intersectsWith(previousLabel, 2) || !newLabelIsInOrderVertically) {
        if (newLabelShouldBeBelowPreviousLabel) {
          labelLogger.debug(`inner collision between ${pl(previousLabel)} v ${pl(newInnerLabel)}(new). Moving new down`)
          innerRadiusLabelCoord.y = previousLabel.topLeftCoord.y + previousLabel.height + 2 // TODO now have a couple hard coded 2's about

          // place X along innerLabelRadius based on new y position
          // Given the yOffset and the labelRadius, use pythagorem to compute the xOffset that places label along labelRadius
          const xOffset = Math.sqrt(Math.pow(innerLabelRadius, 2) - Math.pow(Math.abs(pieCenter.y - innerRadiusLabelCoord.y), 2))
          innerRadiusLabelCoord.x = (newInnerLabel.hemisphere === 'left')
            ? pieCenter.x - xOffset
            : pieCenter.x + xOffset

          newInnerLabel.setTopMedialPoint(innerRadiusLabelCoord)
        } else {
          labelLogger.debug(`inner collision between ${pl(previousLabel)} v ${pl(newInnerLabel)}(new). Moving new up`)
          innerRadiusLabelCoord.y = previousLabel.topLeftCoord.y - 2 // TODO now have a couple hard coded 2's about

          // place X along innerLabelRadius based on new y position
          // Given the yOffset and the labelRadius, use pythagorem to compute the xOffset that places label along labelRadius
          const xOffset = Math.sqrt(Math.pow(innerLabelRadius, 2) - Math.pow(Math.abs(pieCenter.y - innerRadiusLabelCoord.y), 2))
          innerRadiusLabelCoord.x = (newInnerLabel.hemisphere === 'left')
            ? pieCenter.x - xOffset
            : pieCenter.x + xOffset

          newInnerLabel.setBottomMedialPoint(innerRadiusLabelCoord)
        }
      }
    }

    const relativeToCenter = ({ x, y }) => { return { x: x - pieCenter.x, y: y - pieCenter.y } }

    const topLeftCoordIsInArc = ptInArc(relativeToCenter(newInnerLabel.topLeftCoord), 0, innerRadius, 0, 360)
    const topRightCoordIsInArc = ptInArc(relativeToCenter(newInnerLabel.topRightCoord), 0, innerRadius, 0, 360)
    const bottomLeftCoordIsInArc = ptInArc(relativeToCenter(newInnerLabel.bottomLeftCoord), 0, innerRadius, 0, 360)
    const bottomRightCoordIsInArc = ptInArc(relativeToCenter(newInnerLabel.bottomRightCoord), 0, innerRadius, 0, 360)

    const labelIsContainedWithinArc = (
      topLeftCoordIsInArc &&
      topRightCoordIsInArc &&
      bottomLeftCoordIsInArc &&
      bottomRightCoordIsInArc
    )

    labelLogger.debug(`attempt to move ${pl(newInnerLabel)} to inner : ${labelIsContainedWithinArc ? 'succeed' : 'fail'}`)

    if (!labelIsContainedWithinArc) {
      throw new CannotMoveToInner(label, 'out of bounds after adjustment')
    }

    if (newInnerLabel.angleBetweenLabelAndRadial > 45) {
      throw new CannotMoveToInner(label, `label line angle excceds threshold (${newInnerLabel.angleBetweenLabelAndRadial} > ${45}`)
    }

    labelLogger.info(`placed ${pl(label)} inside`)
    innerLabelSet.push(newInnerLabel)
    label.labelShown = false
  },

  nearestNeighborAbove (pie, label) {
    try {
      if (!label) { return null }
      if (label.isTopApexLabel) { return null }

      const labelIndex = _.findIndex(pie.outerLabelData, { id: label.id })
      if (labelIndex === -1) { return null }

      let labelAbove = null
      if (label.inTopLeftQuadrant) {
        labelAbove = pie.outerLabelData[labelIndex + 1]
      } else if (label.inTopRightQuadrant) {
        labelAbove = pie.outerLabelData[labelIndex - 1]
      } else if (label.inBottomLeftQuadrant) {
        if (labelIndex === pie.outerLabelData.length - 1) {
          labelAbove = _.first(pie.outerLabelData)
        } else {
          labelAbove = pie.outerLabelData[labelIndex + 1]
        }
      } else if (label.inBottomRightQuadrant) {
        labelAbove = pie.outerLabelData[labelIndex - 1]
      }

      // sanity check
      if (labelAbove.topLeftCoord.y < label.topLeftCoord.y) {
        return labelAbove
      } else {
        console.error(`nearestNeighborAbove yields incorrect results for label`, label)
        return null
      }
    } catch (e) {
      console.error(`nearestNeighborAbove failed on `, e)
      return null
    }
  },

  nearestNeighborBelow (pie, label) {
    try {
      if (!label) { return null }
      if (label.isBottomApexLabel) { return null }

      const labelIndex = _.findIndex(pie.outerLabelData, { id: label.id })
      if (labelIndex === -1) { return null }

      let labelBelow = null
      if (label.inTopLeftQuadrant) {
        if (labelIndex === 0) {
          labelBelow = _.last(pie.outerLabelData)
        } else {
          labelBelow = pie.outerLabelData[labelIndex - 1]
        }
      } else if (label.inTopRightQuadrant) {
        labelBelow = pie.outerLabelData[labelIndex + 1]
      } else if (label.inBottomLeftQuadrant) {
        labelBelow = pie.outerLabelData[labelIndex - 1]
      } else if (label.inBottomRightQuadrant) {
        labelBelow = pie.outerLabelData[labelIndex + 1]
      }

      // sanity check
      if (labelBelow.topLeftCoord.y > label.topLeftCoord.y) {
        return labelBelow
      } else {
        console.error(`nearestNeighborBelow yields incorrect results for label`, label)
        return null
      }
    } catch (e) {
      console.error(`nearestNeighborBelow failed on `, e)
      return null
    }
  }
}

// helper function to print label. TODO make toString work
function pl (labelData) {
  const ellipsisThreshold = 11
  const labelName = (labelData.label.length > ellipsisThreshold)
    ? `${labelData.label.substr(0, ellipsisThreshold - 3)}...`
    : labelData.label
  // return `${labelName}(${labelData.id})`
  return labelName
}

const exceedsLabelLineAngleThresholdCount = ({ labels, threshold }) =>
  labels
    .filter(({ labelLineAngle }) => labelLineAngle > threshold)
    .length

module.exports = labels
