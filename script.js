(function () {
  const svg = d3.select('#chart');
  const chartCard = document.querySelector('.chart-card');
  const emptyState = document.getElementById('chart-empty');
  const hoverReadout = document.getElementById('hover-readout');
  const hoverDate = document.getElementById('hover-date');
  const hoverPrice = document.getElementById('hover-price');
  const fileInput = document.getElementById('csv-input');
  const fileLabel = document.getElementById('file-label');
  const logToggle = document.getElementById('log-toggle');

  const margin = { top: 12, right: 64, bottom: 32, left: 8 };
  const height = 460;

  let data = [];
  let useLog = false;

  fileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;
    fileLabel.textContent = file.name;

    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      const parsed = parseCSV(loadEvent.target.result);
      if (!parsed.length) {
        alert('No valid date/price rows found in that CSV.');
        return;
      }
      data = parsed;
      emptyState.classList.add('hidden');
      svg.classed('hidden', false);
      hoverReadout.classList.remove('hidden');
      render();
    };
    reader.readAsText(file);
  });

  logToggle.addEventListener('change', () => {
    useLog = logToggle.checked;
    if (data.length) render();
  });

  window.addEventListener('resize', () => {
    if (data.length) render();
  });

  function parseCSV(text) {
    const lines = text.split(/\r\n|\n|\r/).map((line) => line.trim()).filter(Boolean);
    const rows = lines.map(splitCSVLine);

    let startIndex = 0;
    if (rows.length) {
      const [firstDate, firstPrice] = rows[0];
      if (isNaN(Date.parse(firstDate)) || isNaN(parseNumber(firstPrice))) {
        startIndex = 1;
      }
    }

    const parsed = [];
    for (let i = startIndex; i < rows.length; i++) {
      const [rawDate, rawPrice] = rows[i];
      if (rawDate === undefined || rawPrice === undefined) continue;
      const date = parseFlexibleDate(rawDate);
      const price = parseNumber(rawPrice);
      if (isNaN(date.getTime()) || isNaN(price)) continue;
      parsed.push({ date, price });
    }

    parsed.sort((a, b) => a.date - b.date);
    return parsed;
  }

  function splitCSVLine(line) {
    return line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));
  }

  function parseNumber(value) {
    if (value === undefined) return NaN;
    return parseFloat(String(value).replace(/[$,]/g, ''));
  }

  // Bare "YYYY-MM-DD" strings are parsed by `new Date()` as UTC midnight,
  // which can shift to the previous day once rendered in a timezone behind
  // UTC. Parse date-only strings as local dates instead to avoid that.
  function parseFlexibleDate(value) {
    const isoDateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
    if (isoDateOnly) {
      const [, year, month, day] = isoDateOnly;
      return new Date(Number(year), Number(month) - 1, Number(day));
    }
    return new Date(value);
  }

  function render() {
    const width = chartCard.clientWidth - 16;
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    if (innerWidth <= 0) return;

    svg.attr('viewBox', `0 0 ${width} ${height}`).attr('width', width).attr('height', height);
    svg.selectAll('*').remove();

    const x = d3.scaleTime()
      .domain(d3.extent(data, (d) => d.date))
      .range([margin.left, width - margin.right]);

    const prices = data.map((d) => d.price);
    const yDomain = useLog
      ? [d3.min(prices), d3.max(prices)]
      : [d3.min(prices) * 0.98, d3.max(prices) * 1.02];

    const y = (useLog ? d3.scaleLog() : d3.scaleLinear())
      .domain(yDomain)
      .range([height - margin.bottom, margin.top])
      .nice();

    const tickCount = Math.max(2, Math.floor(innerWidth / 90));

    const g = svg.append('g');

    // Gridlines
    g.append('g')
      .attr('class', 'grid')
      .attr('transform', `translate(0,${height - margin.bottom})`)
      .call(d3.axisBottom(x).ticks(tickCount).tickSize(-innerHeight).tickFormat(''));

    // X axis (dates, spaced/skipped by d3 based on available width)
    g.append('g')
      .attr('class', 'axis x-axis')
      .attr('transform', `translate(0,${height - margin.bottom})`)
      .call(d3.axisBottom(x).ticks(tickCount).tickFormat(multiFormat).tickSizeOuter(0));

    // Y axis (price, right-hand side like Google Finance)
    g.append('g')
      .attr('class', 'axis y-axis')
      .attr('transform', `translate(${width - margin.right},0)`)
      .call(d3.axisRight(y).ticks(6, useLog ? '~s' : undefined).tickFormat(d3.format(',.2f')).tickSizeOuter(0));

    // Area fill under the line
    const gradient = svg.append('defs')
      .append('linearGradient')
      .attr('id', 'area-gradient')
      .attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 1);
    gradient.append('stop').attr('offset', '0%').attr('stop-color', '#1a73e8').attr('stop-opacity', 0.18);
    gradient.append('stop').attr('offset', '100%').attr('stop-color', '#1a73e8').attr('stop-opacity', 0);

    const area = d3.area()
      .x((d) => x(d.date))
      .y0(height - margin.bottom)
      .y1((d) => y(d.price));

    g.append('path')
      .datum(data)
      .attr('fill', 'url(#area-gradient)')
      .attr('d', area);

    // Line — points are positioned by real date value, so uneven spacing
    // and interpolation between points is handled automatically by the scale.
    const line = d3.line()
      .x((d) => x(d.date))
      .y((d) => y(d.price));

    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', '#1a73e8')
      .attr('stroke-width', 2)
      .attr('d', line);

    // Hover crosshair
    const focusLine = g.append('line')
      .attr('y1', margin.top)
      .attr('y2', height - margin.bottom)
      .attr('stroke', '#5f6368')
      .attr('stroke-dasharray', '3,3')
      .style('opacity', 0);

    const focusCircle = g.append('circle')
      .attr('r', 4)
      .attr('fill', '#1a73e8')
      .attr('stroke', '#fff')
      .attr('stroke-width', 2)
      .style('opacity', 0);

    const bisectDate = d3.bisector((d) => d.date).left;

    svg.append('rect')
      .attr('class', 'overlay')
      .attr('x', margin.left)
      .attr('y', margin.top)
      .attr('width', innerWidth)
      .attr('height', innerHeight)
      .attr('fill', 'transparent')
      .on('mousemove', onMouseMove)
      .on('mouseleave', onMouseLeave);

    function onMouseMove(event) {
      const [mx] = d3.pointer(event);
      const x0 = x.invert(mx);
      const i = bisectDate(data, x0, 1);
      const d0 = data[i - 1];
      const d1 = data[i];
      const d = !d1 ? d0 : !d0 ? d1 : (x0 - d0.date > d1.date - x0 ? d1 : d0);
      if (!d) return;

      focusLine.attr('x1', x(d.date)).attr('x2', x(d.date)).style('opacity', 1);
      focusCircle.attr('cx', x(d.date)).attr('cy', y(d.price)).style('opacity', 1);

      hoverPrice.textContent = formatPrice(d.price);
      hoverDate.textContent = formatFullDate(d.date);
      hoverReadout.classList.remove('invisible');
    }

    function onMouseLeave() {
      focusLine.style('opacity', 0);
      focusCircle.style('opacity', 0);
      hoverReadout.classList.add('invisible');
    }
  }

  const formatMillisecond = d3.timeFormat('.%L');
  const formatSecond = d3.timeFormat(':%S');
  const formatMinute = d3.timeFormat('%I:%M');
  const formatHour = d3.timeFormat('%I %p');
  const formatDay = d3.timeFormat('%b %d');
  const formatWeek = d3.timeFormat('%b %d');
  const formatMonth = d3.timeFormat('%b %Y');
  const formatYear = d3.timeFormat('%Y');

  function multiFormat(date) {
    const fmt = d3.timeSecond(date) < date ? formatMillisecond
      : d3.timeMinute(date) < date ? formatSecond
      : d3.timeHour(date) < date ? formatMinute
      : d3.timeDay(date) < date ? formatHour
      : d3.timeMonth(date) < date ? (d3.timeWeek(date) < date ? formatDay : formatWeek)
      : d3.timeYear(date) < date ? formatMonth
      : formatYear;
    return fmt(date);
  }

  function formatFullDate(date) {
    return d3.timeFormat('%b %d, %Y')(date);
  }

  function formatPrice(price) {
    return '$' + price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
})();
