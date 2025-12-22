import * as d3 from 'd3';

/**
 * Real-time line chart for PPG signal visualization
 * Based on D3.js with smooth transitions
 */
export class RealTimeChart {
  /**
   * Create a real-time chart
   * @param {Object} options - Chart configuration
   */
  constructor(options = {}) {
    this.margin = options.margin || { top: 20, right: 20, bottom: 50, left: 50 };
    this.width = options.width || 600;
    this.height = options.height || 400;
    this.duration = options.duration || 500;
    this.color = options.color || ['#006400', '#4682b4', '#dc143c'];

    this.svg = null;
    this.g = null;
  }

  /**
   * Render the chart with data
   * @param {HTMLElement} container - Container element
   * @param {Array} data - Chart data
   */
  render(container, data) {
    // Transform data to chart format
    const chartData = [{
      label: 'x',
      values: data.map(d => ({
        time: +d.time,
        value: d.x,
        signal: +d.signal
      }))
    }];

    const t = d3.transition().duration(this.duration).ease(d3.easeLinear);
    const x = d3.scaleTime().rangeRound([0, this.width - this.margin.left - this.margin.right]);
    const y = d3.scaleLinear().rangeRound([this.height - this.margin.top - this.margin.bottom, 0]);
    const z = d3.scaleOrdinal(this.color);

    const xMin = d3.min(chartData, c => d3.min(c.values, d => d.time));
    const xMax = new Date(new Date(d3.max(chartData, c =>
      d3.max(c.values, d => d.time)
    )).getTime() - (this.duration * 2));

    x.domain([xMin, xMax]);
    y.domain([
      d3.min(chartData, c => d3.min(c.values, d => d.value)),
      d3.max(chartData, c => d3.max(c.values, d => d.value))
    ]);
    z.domain(chartData.map(c => c.label));

    const line = d3.line()
      .curve(d3.curveBasis)
      .x(d => x(d.time))
      .y(d => y(d.value));

    // Initial setup
    const selection = d3.select(container);
    let svg = selection.selectAll('svg').data([chartData]);
    const gEnter = svg.enter().append('svg').append('g');

    gEnter.append('g').attr('class', 'axis x');
    gEnter.append('g').attr('class', 'axis y');
    gEnter.append('defs').append('clipPath')
      .attr('id', 'clip')
      .append('rect')
      .attr('width', this.width - this.margin.left - this.margin.right)
      .attr('height', this.height - this.margin.top - this.margin.bottom);

    gEnter.append('g')
      .attr('class', 'lines')
      .attr('clip-path', 'url(#clip)')
      .selectAll('.data').data(chartData).enter()
      .append('path')
      .attr('class', 'data');

    // Update
    svg = selection.select('svg');
    svg.attr('width', this.width).attr('height', this.height);

    const g = svg.select('g')
      .attr('transform', `translate(${this.margin.left},${this.margin.top})`);

    g.select('defs clipPath rect')
      .transition(t)
      .attr('width', this.width - this.margin.left - this.margin.right)
      .attr('height', this.height - this.margin.top - this.margin.right);

    g.selectAll('g path.data')
      .data(chartData)
      .style('stroke', this.color[1])
      .style('stroke-width', 3)
      .style('fill', 'none')
      .transition()
      .duration(this.duration)
      .ease(d3.easeLinear)
      .on('start', function tick() {
        d3.select(this)
          .attr('d', d => line(d.values))
          .attr('transform', null);

        const xMinLess = new Date(new Date(xMin).getTime() - this.duration);
        d3.active(this)
          .attr('transform', `translate(${x(xMinLess)},0)`)
          .transition()
          .on('start', tick);
      }.bind(this));

    this.svg = svg;
    this.g = g;
  }

  /**
   * Update chart dimensions
   * @param {number} width - New width
   */
  setWidth(width) {
    this.width = width;
    if (this.svg) {
      this.svg.attr('width', width);
    }
  }

  /**
   * Destroy the chart and cleanup
   */
  destroy() {
    if (this.svg) {
      this.svg.remove();
      this.svg = null;
      this.g = null;
    }
  }
}
