(function () {
  const COLORS = {
    up: '#90e58c',
    down: '#ffa9af',
    secondary: '#adafb8',
    surface: '#17191f',
  };

  const svg = d3.select('#chart');
  const chartCard = document.querySelector('.chart-card');
  const emptyState = document.getElementById('chart-empty');
  const readout = document.getElementById('readout');
  const readoutPrice = document.getElementById('readout-price');
  const readoutChange = document.getElementById('readout-change');
  const readoutDate = document.getElementById('readout-date');
  const fileInput = document.getElementById('csv-input');
  const fileLabel = document.getElementById('file-label');
  const logToggle = document.getElementById('log-toggle');

  const margin = { top: 16, right: 20, bottom: 32, left: 72 };
  const height = 460;

  let data = [];
  let useLog = false;
  let selection = null; // {start, end} data indices, sticky until a plain click clears it

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
      selection = null;
      emptyState.classList.add('hidden');
      svg.classed('hidden', false);
      readout.classList.remove('hidden');
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

    const xScale = d3.scaleTime()
      .domain(d3.extent(data, (d) => d.date))
      .range([margin.left, width - margin.right]);

    const prices = data.map((d) => d.price);
    const yDomain = useLog
      ? [d3.min(prices), d3.max(prices)]
      : [d3.min(prices) * 0.98, d3.max(prices) * 1.02];

    const yScale = (useLog ? d3.scaleLog() : d3.scaleLinear())
      .domain(yDomain)
      .range([height - margin.bottom, margin.top])
      .nice();

    const tickCount = Math.max(2, Math.floor(innerWidth / 90));
    const g = svg.append('g');

    // Gridlines
    g.append('g')
      .attr('class', 'grid')
      .attr('transform', `translate(0,${height - margin.bottom})`)
      .call(d3.axisBottom(xScale).ticks(tickCount).tickSize(-innerHeight).tickFormat(''));

    // X axis (dates, spaced/skipped by d3 based on available width)
    g.append('g')
      .attr('class', 'axis x-axis')
      .attr('transform', `translate(0,${height - margin.bottom})`)
      .call(d3.axisBottom(xScale).ticks(tickCount).tickFormat(multiFormat).tickSizeOuter(0));

    // Y axis (price, left-hand side like Google Finance)
    g.append('g')
      .attr('class', 'axis y-axis')
      .attr('transform', `translate(${margin.left},0)`)
      .call(d3.axisLeft(yScale).ticks(6, useLog ? '~s' : undefined).tickFormat(d3.format(',.2f')).tickSizeOuter(0));

    const first = data[0];
    const last = data[data.length - 1];
    const overallUp = last.price >= first.price;
    const trendColor = overallUp ? COLORS.up : COLORS.down;

    // Reference dotted line at the first data point's price
    g.append('line')
      .attr('class', 'reference-line')
      .attr('x1', margin.left)
      .attr('x2', width - margin.right)
      .attr('y1', yScale(first.price))
      .attr('y2', yScale(first.price));

    g.append('text')
      .attr('class', 'reference-label')
      .attr('x', width - margin.right)
      .attr('y', yScale(first.price) - 6)
      .attr('text-anchor', 'end')
      .text(`Start ${formatPrice(first.price)}`);

    // Area fill under the line, tinted by overall trend
    const gradient = svg.append('defs')
      .append('linearGradient')
      .attr('id', 'area-gradient')
      .attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 1);
    gradient.append('stop').attr('offset', '0%').attr('stop-color', trendColor).attr('stop-opacity', 0.25);
    gradient.append('stop').attr('offset', '100%').attr('stop-color', trendColor).attr('stop-opacity', 0);

    const area = d3.area()
      .x((d) => xScale(d.date))
      .y0(height - margin.bottom)
      .y1((d) => yScale(d.price));

    g.append('path')
      .datum(data)
      .attr('fill', 'url(#area-gradient)')
      .attr('d', area);

    // Line — points are positioned by real date value, so uneven spacing
    // and interpolation between points is handled automatically by the scale.
    const line = d3.line()
      .x((d) => xScale(d.date))
      .y((d) => yScale(d.price));

    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', trendColor)
      .attr('stroke-width', 2)
      .attr('d', line);

    g.append('circle')
      .attr('cx', xScale(last.date))
      .attr('cy', yScale(last.price))
      .attr('r', 4)
      .attr('fill', trendColor);

    // Sticky range-selection visuals (shaded region + boundary lines/dots)
    const selectionRegion = g.append('rect')
      .attr('y', margin.top)
      .attr('height', innerHeight)
      .style('display', 'none');

    const selectionLineStart = g.append('line')
      .attr('y1', margin.top).attr('y2', height - margin.bottom)
      .attr('class', 'selection-line')
      .style('display', 'none');

    const selectionLineEnd = g.append('line')
      .attr('y1', margin.top).attr('y2', height - margin.bottom)
      .attr('class', 'selection-line')
      .style('display', 'none');

    const selectionDotStart = g.append('circle').attr('r', 4).style('display', 'none');
    const selectionDotEnd = g.append('circle').attr('r', 4).style('display', 'none');

    // Single-point hover crosshair
    const focusLineH = g.append('line')
      .attr('x1', margin.left).attr('x2', width - margin.right)
      .attr('stroke', COLORS.secondary)
      .attr('stroke-dasharray', '3,3')
      .style('opacity', 0);

    const focusLineV = g.append('line')
      .attr('y1', margin.top).attr('y2', height - margin.bottom)
      .attr('stroke', COLORS.secondary)
      .attr('stroke-dasharray', '3,3')
      .style('opacity', 0);

    const focusCircle = g.append('circle')
      .attr('r', 4)
      .attr('stroke', COLORS.surface)
      .attr('stroke-width', 2)
      .style('opacity', 0);

    const bisectDate = d3.bisector((d) => d.date).left;

    function clampX(mx) {
      return Math.min(Math.max(mx, margin.left), width - margin.right);
    }

    function nearestIndex(mx) {
      const x0 = xScale.invert(mx);
      const i = bisectDate(data, x0, 1);
      const d0 = data[i - 1];
      const d1 = data[i];
      if (!d1) return data.length - 1;
      if (!d0) return 0;
      return (x0 - d0.date > d1.date - x0) ? i : i - 1;
    }

    function clearSelectionVisual() {
      selectionRegion.style('display', 'none');
      selectionLineStart.style('display', 'none');
      selectionLineEnd.style('display', 'none');
      selectionDotStart.style('display', 'none');
      selectionDotEnd.style('display', 'none');
    }

    function showSelection(i0, i1) {
      const a = Math.min(i0, i1);
      const b = Math.max(i0, i1);
      const startD = data[a];
      const endD = data[b];
      const up = endD.price >= startD.price;
      const color = up ? COLORS.up : COLORS.down;

      selectionRegion
        .attr('x', xScale(startD.date))
        .attr('width', Math.max(0, xScale(endD.date) - xScale(startD.date)))
        .attr('class', `selection-region ${up ? 'up' : 'down'}`)
        .style('display', null);

      selectionLineStart
        .attr('x1', xScale(startD.date)).attr('x2', xScale(startD.date))
        .attr('class', `selection-line ${up ? 'up' : 'down'}`)
        .style('display', null);

      selectionLineEnd
        .attr('x1', xScale(endD.date)).attr('x2', xScale(endD.date))
        .attr('class', `selection-line ${up ? 'up' : 'down'}`)
        .style('display', null);

      selectionDotStart
        .attr('cx', xScale(startD.date)).attr('cy', yScale(startD.price))
        .attr('fill', color).style('display', null);

      selectionDotEnd
        .attr('cx', xScale(endD.date)).attr('cy', yScale(endD.price))
        .attr('fill', color).style('display', null);

      setReadoutForRange(startD, endD);
    }

    function setReadoutForRange(startD, endD) {
      const delta = endD.price - startD.price;
      const pct = (delta / startD.price) * 100;
      const up = delta >= 0;
      readoutPrice.textContent = formatPrice(endD.price);
      readoutChange.textContent = `${up ? '▲' : '▼'} ${formatSignedPrice(delta)} (${formatSignedPct(pct)})`;
      readoutChange.className = `readout-change ${up ? 'up' : 'down'}`;
      readoutDate.textContent = `${formatFullDate(startD.date)} – ${formatFullDate(endD.date)}`;
    }

    function setReadoutForPoint(d) {
      const delta = d.price - first.price;
      const pct = (delta / first.price) * 100;
      const up = delta >= 0;
      readoutPrice.textContent = formatPrice(d.price);
      readoutChange.textContent = `${up ? '▲' : '▼'} ${formatSignedPrice(delta)} (${formatSignedPct(pct)})`;
      readoutChange.className = `readout-change ${up ? 'up' : 'down'}`;
      readoutDate.textContent = formatFullDate(d.date);
    }

    function setReadoutDefault() {
      setReadoutForPoint(last);
      readoutDate.textContent = `${formatFullDate(first.date)} – ${formatFullDate(last.date)}`;
    }

    const overlay = svg.append('rect')
      .attr('class', 'overlay')
      .attr('x', margin.left)
      .attr('y', margin.top)
      .attr('width', innerWidth)
      .attr('height', innerHeight)
      .attr('fill', 'transparent');

    const overlayNode = overlay.node();
    let isDragging = false;
    let dragMoved = false;
    let dragStartIndex = null;

    function onWindowMouseMove(event) {
      const [mx] = d3.pointer(event, overlayNode);
      const idx = nearestIndex(clampX(mx));
      dragMoved = dragMoved || idx !== dragStartIndex;
      showSelection(dragStartIndex, idx);
      focusLineV.style('opacity', 0);
      focusLineH.style('opacity', 0);
      focusCircle.style('opacity', 0);
    }

    function onWindowMouseUp(event) {
      window.removeEventListener('mousemove', onWindowMouseMove);
      window.removeEventListener('mouseup', onWindowMouseUp);
      isDragging = false;
      const [mx] = d3.pointer(event, overlayNode);
      const endIndex = nearestIndex(clampX(mx));
      if (!dragMoved || endIndex === dragStartIndex) {
        selection = null;
        clearSelectionVisual();
        setReadoutDefault();
      } else {
        selection = { start: Math.min(dragStartIndex, endIndex), end: Math.max(dragStartIndex, endIndex) };
        showSelection(dragStartIndex, endIndex);
      }
    }

    overlay.on('mousedown', (event) => {
      event.preventDefault();
      const [mx] = d3.pointer(event, overlayNode);
      dragStartIndex = nearestIndex(clampX(mx));
      isDragging = true;
      dragMoved = false;
      window.addEventListener('mousemove', onWindowMouseMove);
      window.addEventListener('mouseup', onWindowMouseUp);
    });

    overlay.on('mousemove', (event) => {
      if (isDragging || selection) return;
      const [mx] = d3.pointer(event, overlayNode);
      const d = data[nearestIndex(clampX(mx))];
      if (!d) return;
      focusLineV.attr('x1', xScale(d.date)).attr('x2', xScale(d.date)).style('opacity', 1);
      focusLineH.attr('y1', yScale(d.price)).attr('y2', yScale(d.price)).style('opacity', 1);
      focusCircle.attr('cx', xScale(d.date)).attr('cy', yScale(d.price)).attr('fill', trendColor).style('opacity', 1);
      setReadoutForPoint(d);
    });

    overlay.on('mouseleave', () => {
      if (isDragging || selection) return;
      focusLineV.style('opacity', 0);
      focusLineH.style('opacity', 0);
      focusCircle.style('opacity', 0);
      setReadoutDefault();
    });

    if (selection) {
      showSelection(selection.start, selection.end);
    } else {
      setReadoutDefault();
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

  function formatSignedPrice(delta) {
    const sign = delta >= 0 ? '+' : '−';
    return `${sign}$${Math.abs(delta).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function formatSignedPct(pct) {
    const sign = pct >= 0 ? '+' : '−';
    return `${sign}${Math.abs(pct).toFixed(2)}%`;
  }
})();
