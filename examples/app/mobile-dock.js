/* Fixed actions with content space sized to the real controls, including
   larger text and the phone safe area. Runs only on layout events, never as
   part of the capture animation loop. */
(() => {
  const root = document.documentElement;
  const app = document.getElementById('app');
  const screens = [...document.querySelectorAll('.screen')];
  const docks = [...document.querySelectorAll('.mobile-action-dock')];
  const mobile = matchMedia('(max-width: 699px)');
  let frame = 0;
  let reserve = -1;

  function measure() {
    frame = 0;
    const viewport = window.visualViewport;
    // Keep the dock above a soft keyboard. Pinch zoom retains normal fixed
    // positioning so the action bar does not chase the zoomed document.
    const inset = mobile.matches && viewport && viewport.scale === 1
      ? Math.max(0, innerHeight - viewport.height - viewport.offsetTop) : 0;
    root.style.setProperty('--mobile-viewport-inset', `${Math.round(inset)}px`);
    const screen = screens.find(node => !node.hidden);
    const dock = mobile.matches ? screen?.querySelector('.mobile-action-dock') : null;
    const rect = dock?.getBoundingClientRect();
    const space = rect?.height > 0
      ? Math.ceil(rect.height + parseFloat(getComputedStyle(dock).bottom) + 12) : 0;
    if (space !== reserve) {
      reserve = space;
      root.style.setProperty('--mobile-dock-reserve', `${space}px`);
    }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(measure);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(app, { attributes:true, attributeFilter:['data-active-screen'] });
  for (const screen of screens) observer.observe(screen, { attributes:true, attributeFilter:['hidden'] });
  observer.observe(document.getElementById('btn-start'), { attributes:true, attributeFilter:['hidden'] });
  if (typeof ResizeObserver !== 'undefined') {
    const sizes = new ResizeObserver(schedule);
    for (const dock of docks) sizes.observe(dock);
  }
  mobile.addEventListener('change', schedule);
  window.addEventListener('resize', schedule, { passive:true });
  window.visualViewport?.addEventListener('resize', schedule, { passive:true });
  window.visualViewport?.addEventListener('scroll', schedule, { passive:true });
  document.fonts?.ready.then(schedule);
  document.addEventListener('focusin', event => {
    const target = event.target;
    if (!mobile.matches || !(target instanceof HTMLElement)
      || target.closest('.mobile-action-dock,[role="dialog"]')) return;
    schedule();
    requestAnimationFrame(() => {
      const dock = screens.find(node => !node.hidden)?.querySelector('.mobile-action-dock');
      const visibleBottom = dock?.getBoundingClientRect().top - 12 || innerHeight;
      const rect = target.getBoundingClientRect();
      if (rect.bottom > visibleBottom || rect.top < 0) target.scrollIntoView({ block:'center', behavior:'instant' });
    });
  });
  schedule();
})();
