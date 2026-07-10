let locked = false;

export function lockPageZoom(): void {
  if (locked) return;
  locked = true;

  document.addEventListener(
    'touchmove',
    (event) => {
      if (event.touches.length > 1) event.preventDefault();
    },
    { passive: false },
  );

  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(
      type,
      (event) => {
        event.preventDefault();
      },
      { passive: false },
    );
  }

  let lastTouchEnd = 0;
  document.addEventListener(
    'touchend',
    (event) => {
      const now = event.timeStamp;
      if (now - lastTouchEnd <= 300) event.preventDefault();
      lastTouchEnd = now;
    },
    { passive: false },
  );
}
