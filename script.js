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
  const readoutCagr = document.getElementById('readout-cagr');
  const readoutDate = document.getElementById('readout-date');
  const fileInput = document.getElementById('csv-input');
  const fileLabel = document.getElementById('file-label');
  const logToggle = document.getElementById('log-toggle');
  const startDateInput = document.getElementById('start-date');
  const endDateInput = document.getElementById('end-date');

  const margin = { top: 16, right: 20, bottom: 32, left: 92 };
  const height = 920;
  const emptyStateDefaultText = emptyState.textContent;
  const toInputValue = d3.timeFormat('%Y-%m-%d');

  let allData = []; // full parsed CSV, unfiltered
  let data = []; // date-range-filtered subset actually rendered
  let useLog = false;
  let selection = null; // {start, end} data indices, sticky until a plain click clears it
  let hoverDate = null; // last hovered/pinch-anchored date, redrawn as the crosshair on every render

  // Precise (sub-day) pan/zoom state in ms, kept separate from the date
  // inputs' displayed value. The <input type="date"> fields only hold whole
  // days, so if gesture math read its range back from them, every single
  // touch/wheel step would round-trip through day granularity and discard
  // its own progress — a slow or fine-grained gesture (touch produces many
  // tiny steps) would look completely stuck until one step happened to
  // cross a full day on its own. These stay precise and accumulate; the
  // inputs (and the actual data filtering) are just a rounded view of them.
  let viewStart = null;
  let viewEnd = null;

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
      allData = parsed;

      const [minDate, maxDate] = d3.extent(parsed, (d) => d.date);
      startDateInput.min = toInputValue(minDate);
      startDateInput.max = toInputValue(maxDate);
      endDateInput.min = toInputValue(minDate);
      endDateInput.max = toInputValue(maxDate);
      startDateInput.value = toInputValue(minDate);
      endDateInput.value = toInputValue(maxDate);
      viewStart = minDate.getTime();
      viewEnd = maxDate.getTime();

      useLog = true;
      logToggle.checked = true;
      hoverDate = null;

      applyDateFilter();
    };
    reader.readAsText(file);
  });

  logToggle.addEventListener('change', () => {
    useLog = logToggle.checked;
    if (data.length) render();
  });

  // A manual edit of the date fields is itself day-precision, so it's a
  // legitimate point to resync the precise pan/zoom state to match.
  function onDateInputChange() {
    const [dataMin, dataMax] = d3.extent(allData, (d) => d.date);
    viewStart = (startDateInput.value ? parseFlexibleDate(startDateInput.value) : dataMin).getTime();
    viewEnd = (endDateInput.value ? parseFlexibleDate(endDateInput.value) : dataMax).getTime();
    applyDateFilter();
  }

  startDateInput.addEventListener('change', onDateInputChange);
  endDateInput.addEventListener('change', onDateInputChange);

  window.addEventListener('resize', () => {
    if (data.length) render();
  });

  // Trackpad pinch gestures (and ctrl+scroll) arrive as wheel events with
  // ctrlKey set — that's the browser convention, there's no dedicated pinch
  // API. deltaY < 0 means fingers spreading apart (zoom in / narrower range),
  // deltaY > 0 means pinching together (zoom out / wider range). A plain
  // two-finger horizontal swipe (no ctrlKey, deltaX dominant) pans instead,
  // like panning a zoomed photo in Preview. Applied directly per event (not
  // batched via requestAnimationFrame) since rAF can stall in a
  // backgrounded/unfocused tab and silently drop the gesture.
  const PINCH_SENSITIVITY = 0.005;
  const MIN_RANGE_MS = 24 * 60 * 60 * 1000;

  chartCard.addEventListener('wheel', (event) => {
    if (!allData.length) return;
    if (event.ctrlKey) {
      event.preventDefault();
      zoomByFactor(Math.exp(Math.max(-80, Math.min(80, event.deltaY)) * PINCH_SENSITIVITY), event.clientX);
    } else if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      event.preventDefault();
      applyPan(event.deltaX);
    }
  }, { passive: false });

  // Two-finger touch gestures (iPadOS/mobile Safari): pinch distance drives
  // zoom, the moving midpoint drives pan, combined in the same touchmove so
  // a pinch-and-drag feels like one continuous gesture. Bound to chartCard
  // (not the per-render overlay) because zooming/panning re-renders the SVG
  // on every step, which would otherwise tear down the listener mid-gesture.
  // iOS delivers touchmove events faster than a full chart re-render can
  // keep up with, so applying every single event synchronously backs up the
  // main thread and looks laggy/jumpy instead of continuous. Touchmove only
  // records the latest finger positions; the actual zoom+pan+render is
  // batched to once per animation frame, always using the most recent
  // positions by the time the frame runs. Safe to rely on rAF here (unlike
  // the wheel handler) since a touch gesture only happens while the tab is
  // focused and visible.
  let touchGestureActive = false;
  let touchPrevDistance = null;
  let touchPrevMidX = null;
  let touchLatest = null;
  let touchFrameQueued = false;

  function touchDistance(t1, t2) {
    return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
  }

  function touchMidX(t1, t2) {
    return (t1.clientX + t2.clientX) / 2;
  }

  function endTouchGesture() {
    touchGestureActive = false;
    touchPrevDistance = null;
    touchPrevMidX = null;
    touchLatest = null;
  }

  function processTouchFrame() {
    touchFrameQueued = false;
    if (!touchGestureActive || !touchLatest) return;
    const distance = touchDistance(touchLatest[0], touchLatest[1]);
    const midX = touchMidX(touchLatest[0], touchLatest[1]);

    // Fingers spreading apart (distance growing) narrows the range, mirroring
    // the trackpad pinch-out = zoom in convention. Ratio-based, so it's
    // naturally proportional to how far the fingers actually moved — no
    // separate sensitivity constant needed like the per-tick wheel delta.
    if (touchPrevDistance) {
      zoomByFactor(Math.max(0.5, Math.min(2, touchPrevDistance / distance)), midX);
    }
    if (touchPrevMidX !== null) {
      applyPan(touchPrevMidX - midX);
    }

    touchPrevDistance = distance;
    touchPrevMidX = midX;
  }

  chartCard.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 2 || !allData.length) return;
    event.preventDefault();
    touchGestureActive = true;
    touchPrevDistance = touchDistance(event.touches[0], event.touches[1]);
    touchPrevMidX = touchMidX(event.touches[0], event.touches[1]);
  }, { passive: false });

  chartCard.addEventListener('touchmove', (event) => {
    if (!touchGestureActive || event.touches.length !== 2) return;
    event.preventDefault();
    touchLatest = [event.touches[0], event.touches[1]];
    if (touchFrameQueued) return;
    touchFrameQueued = true;
    requestAnimationFrame(processTouchFrame);
  }, { passive: false });

  chartCard.addEventListener('touchend', endTouchGesture);
  chartCard.addEventListener('touchcancel', endTouchGesture);

  // Date at a given screen x position at the time of the gesture, so zooming
  // keeps that point fixed on screen instead of always zooming toward the
  // center.
  function cursorDateAtClientX(clientX, curStart, curEnd) {
    const rect = svg.node().getBoundingClientRect();
    if (!rect.width) return null;
    const innerLeft = rect.left + margin.left;
    const innerRight = rect.left + rect.width - margin.right;
    if (innerRight <= innerLeft) return null;
    const fraction = (Math.min(Math.max(clientX, innerLeft), innerRight) - innerLeft) / (innerRight - innerLeft);
    return curStart + fraction * (curEnd - curStart);
  }

  function currentRange() {
    const [dataMin, dataMax] = d3.extent(allData, (d) => d.date);
    return { dataMin: dataMin.getTime(), dataMax: dataMax.getTime(), curStart: viewStart, curEnd: viewEnd };
  }

  // Slide the window rather than clamping each end independently, so
  // running into a data boundary doesn't skew the range off-center.
  function clampRange(start, end, dataMin, dataMax) {
    if (start < dataMin) {
      end += dataMin - start;
      start = dataMin;
    }
    if (end > dataMax) {
      start -= end - dataMax;
      end = dataMax;
    }
    return { start: Math.max(dataMin, start), end: Math.min(dataMax, end) };
  }

  function setRange(start, end) {
    viewStart = start;
    viewEnd = end;
    startDateInput.value = toInputValue(new Date(start));
    endDateInput.value = toInputValue(new Date(end));
    applyDateFilter();
  }

  function zoomByFactor(factor, clientX) {
    const { dataMin, dataMax, curStart, curEnd } = currentRange();
    const anchor = cursorDateAtClientX(clientX, curStart, curEnd) ?? (curStart + curEnd) / 2;
    const anchorFraction = (anchor - curStart) / (curEnd - curStart);

    const fullRangeMs = dataMax - dataMin;
    const newRangeMs = Math.min(fullRangeMs, Math.max(MIN_RANGE_MS, (curEnd - curStart) * factor));

    // Keep the date under the cursor at the same fractional position within
    // the new range as it was in the old one, so it stays visually fixed.
    const newStart = anchor - anchorFraction * newRangeMs;
    const newEnd = newStart + newRangeMs;

    // Pin the crosshair to the anchor date so it stays visible through the
    // re-render instead of only reappearing on the next real mousemove.
    hoverDate = new Date(anchor);

    const clamped = clampRange(newStart, newEnd, dataMin, dataMax);
    setRange(clamped.start, clamped.end);
  }

  function applyPan(deltaX) {
    const { dataMin, dataMax, curStart, curEnd } = currentRange();
    const width = chartCard.clientWidth - 16;
    const innerWidth = width - margin.left - margin.right;
    if (innerWidth <= 0) return;

    // 1:1 with pixels moved, so the chart tracks the swipe the way an image
    // tracks your fingers when panning in Preview.
    const shiftMs = deltaX * ((curEnd - curStart) / innerWidth);
    const clamped = clampRange(curStart + shiftMs, curEnd + shiftMs, dataMin, dataMax);
    setRange(clamped.start, clamped.end);
  }

  function applyDateFilter() {
    if (!allData.length) return;

    const startBound = startDateInput.value ? parseFlexibleDate(startDateInput.value) : null;
    const endBound = endDateInput.value ? parseFlexibleDate(endDateInput.value) : null;

    data = allData.filter((d) => {
      if (startBound && d.date < startBound) return false;
      if (endBound && d.date > endBound) return false;
      return true;
    });
    selection = null;

    if (!data.length) {
      svg.classed('hidden', true);
      readout.classList.add('hidden');
      emptyState.textContent = 'No data in the selected date range.';
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');
    emptyState.textContent = emptyStateDefaultText;
    svg.classed('hidden', false);
    readout.classList.remove('hidden');
    render();
  }

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

    // Log scale skips .nice() on purpose: nice() rounds a log domain outward
    // to the nearest power of ten, so a max that inches from 999,999 to
    // 1,000,001 would snap the axis top from 1M to 10M. Proportional padding
    // instead keeps the domain (and its ticks) shifting continuously as the
    // visible min/max change while zooming/panning.
    const prices = data.map((d) => d.price);
    const yDomain = useLog
      ? [d3.min(prices) / 1.06, d3.max(prices) * 1.06]
      : [d3.min(prices) * 0.98, d3.max(prices) * 1.02];

    const yScale = useLog
      ? d3.scaleLog().domain(yDomain).range([height - margin.bottom, margin.top])
      : d3.scaleLinear().domain(yDomain).range([height - margin.bottom, margin.top]).nice();

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
    const yAxis = d3.axisLeft(yScale).tickFormat(d3.format(',.2f')).tickSizeOuter(0);
    if (useLog) {
      // Plain d3 log ticks collapse to bare powers of ten once the domain
      // spans multiple decades (e.g. 1M straight to 10M) — use finer,
      // adaptively-spaced values instead so the axis reads smoothly.
      yAxis.tickValues(logTickValues(yScale.domain()));
    } else {
      yAxis.ticks(6);
    }
    g.append('g')
      .attr('class', 'axis y-axis')
      .attr('transform', `translate(${margin.left},0)`)
      .call(yAxis);

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
      readoutCagr.textContent = formatCagr(calculateCagr(startD, endD));
      readoutDate.textContent = `${formatFullDate(startD.date)} – ${formatFullDate(endD.date)}`;
    }

    function setReadoutForPoint(d) {
      const delta = d.price - first.price;
      const pct = (delta / first.price) * 100;
      const up = delta >= 0;
      readoutPrice.textContent = formatPrice(d.price);
      readoutChange.textContent = `${up ? '▲' : '▼'} ${formatSignedPrice(delta)} (${formatSignedPct(pct)})`;
      readoutChange.className = `readout-change ${up ? 'up' : 'down'}`;
      readoutCagr.textContent = formatCagr(calculateCagr(first, d));
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
        hoverDate = null;
        clearSelectionVisual();
        setReadoutDefault();
      } else {
        selection = { start: Math.min(dragStartIndex, endIndex), end: Math.max(dragStartIndex, endIndex) };
        showSelection(dragStartIndex, endIndex);
      }
    }

    function showHoverPoint(d) {
      focusLineV.attr('x1', xScale(d.date)).attr('x2', xScale(d.date)).style('opacity', 1);
      focusLineH.attr('y1', yScale(d.price)).attr('y2', yScale(d.price)).style('opacity', 1);
      focusCircle.attr('cx', xScale(d.date)).attr('cy', yScale(d.price)).attr('fill', trendColor).style('opacity', 1);
      setReadoutForPoint(d);
    }

    overlay.on('mousedown', (event) => {
      event.preventDefault();
      const [mx] = d3.pointer(event, overlayNode);
      dragStartIndex = nearestIndex(clampX(mx));
      isDragging = true;
      dragMoved = false;
      hoverDate = null;
      window.addEventListener('mousemove', onWindowMouseMove);
      window.addEventListener('mouseup', onWindowMouseUp);
    });

    overlay.on('mousemove', (event) => {
      if (isDragging || selection) return;
      const [mx] = d3.pointer(event, overlayNode);
      const d = data[nearestIndex(clampX(mx))];
      if (!d) return;
      hoverDate = d.date;
      showHoverPoint(d);
    });

    overlay.on('mouseleave', () => {
      if (isDragging || selection) return;
      hoverDate = null;
      focusLineV.style('opacity', 0);
      focusLineH.style('opacity', 0);
      focusCircle.style('opacity', 0);
      setReadoutDefault();
    });

    // One-finger touch drag mirrors mouse click-and-drag range selection.
    // Safe to key off render()'s local xScale/nearestIndex here (unlike the
    // two-finger touch gestures above) because a plain drag never changes
    // the date range mid-gesture, so this overlay instance stays alive for
    // the whole drag instead of being torn down by a re-render.
    function onWindowTouchMove(event) {
      if (event.touches.length !== 1) return;
      event.preventDefault();
      const [tx] = d3.pointer(event.touches[0], overlayNode);
      const idx = nearestIndex(clampX(tx));
      dragMoved = dragMoved || idx !== dragStartIndex;
      showSelection(dragStartIndex, idx);
      focusLineV.style('opacity', 0);
      focusLineH.style('opacity', 0);
      focusCircle.style('opacity', 0);
    }

    function onWindowTouchEnd(event) {
      window.removeEventListener('touchmove', onWindowTouchMove);
      window.removeEventListener('touchend', onWindowTouchEnd);
      window.removeEventListener('touchcancel', onWindowTouchEnd);
      isDragging = false;
      const touch = event.changedTouches[0];
      const [tx] = d3.pointer(touch, overlayNode);
      const endIndex = nearestIndex(clampX(tx));
      if (!dragMoved || endIndex === dragStartIndex) {
        selection = null;
        hoverDate = null;
        clearSelectionVisual();
        setReadoutDefault();
      } else {
        selection = { start: Math.min(dragStartIndex, endIndex), end: Math.max(dragStartIndex, endIndex) };
        showSelection(dragStartIndex, endIndex);
      }
    }

    overlay.on('touchstart', (event) => {
      if (event.touches.length !== 1) return; // let chartCard's two-finger handler take pinch/pan
      event.preventDefault();
      const [tx] = d3.pointer(event.touches[0], overlayNode);
      dragStartIndex = nearestIndex(clampX(tx));
      isDragging = true;
      dragMoved = false;
      hoverDate = null;
      window.addEventListener('touchmove', onWindowTouchMove, { passive: false });
      window.addEventListener('touchend', onWindowTouchEnd);
      window.addEventListener('touchcancel', onWindowTouchEnd);
    }, { passive: false });

    if (selection) {
      showSelection(selection.start, selection.end);
    } else if (hoverDate) {
      // Redraws the crosshair immediately on render (e.g. after a pinch-zoom
      // step) instead of waiting for the next real mousemove.
      showHoverPoint(data[nearestIndex(clampX(xScale(hoverDate)))]);
    } else {
      setReadoutDefault();
    }
  }

  // Generates smoothly-graduated tick values for a log scale instead of only
  // bare powers of ten (e.g. 1M, 2M, 5M, 10M rather than a single 1M -> 10M
  // jump). Uses finer 1-9 steps within a decade, coarsening to 1/2/5 or 1/5
  // once the domain spans many decades so the axis stays readable.
  function logTickValues(domain) {
    const [lo, hi] = domain;
    if (!(lo > 0) || !(hi > lo)) return [];
    const decades = Math.log10(hi / lo);
    const multiples = decades > 4 ? [1, 5] : decades > 1.5 ? [1, 2, 5] : [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const startExp = Math.floor(Math.log10(lo));
    const endExp = Math.ceil(Math.log10(hi));
    const ticks = [];
    for (let exp = startExp; exp <= endExp; exp++) {
      for (const m of multiples) {
        const v = m * Math.pow(10, exp);
        if (v >= lo && v <= hi) ticks.push(v);
      }
    }
    return ticks;
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

  // Compound annual growth rate between two points, annualizing whatever
  // time span is currently displayed (full range, hover reference, or drag selection).
  function calculateCagr(startD, endD) {
    const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
    const years = (endD.date - startD.date) / msPerYear;
    if (years <= 0 || startD.price <= 0) return null;
    return Math.pow(endD.price / startD.price, 1 / years) - 1;
  }

  function formatCagr(cagr) {
    if (cagr === null || !isFinite(cagr)) return '';
    return `${(cagr * 100).toFixed(2)}% CAGR`;
  }
})();
