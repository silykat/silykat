// Claude Code's start logo, drawn from the block characters it prints (read in a real terminal,
// Claude Code 2.1.301), so that it does not depend on how a font draws them.
(function () {
  const rows = [' ▐▛███▛█ ', '▝▜██████▀', ' ▝▝   ▝▝ '];
  // Quadrants: top-left, top-right, bottom-left, bottom-right.
  const q = { ' ': 0, '▐': 0b0101, '▛': 0b1110, '█': 0b1111, '▝': 0b0100, '▜': 0b1101, '▀': 0b1100, '▌': 0b1010 };
  const cw = 7.5, ch = 17;
  // Cells printed on a black background (the eyes show through it).
  const black = { 0: [2, 3, 4, 5, 6, 7], 1: [2, 3, 4, 5, 6] };
  let bg = '';
  Object.entries(black).forEach(([y, xs]) =>
    xs.forEach((x) => (bg += `<rect x="${x * cw}" y="${y * ch}" width="${cw + 0.3}" height="${ch + 0.3}"/>`)),
  );
  let rects = '';
  rows.forEach((row, y) =>
    row.split('').forEach((c, x) => {
      const m = q[c] ?? 0;
      [[8, 0, 0], [4, 1, 0], [2, 0, 1], [1, 1, 1]].forEach(([bit, dx, dy]) => {
        if (m & bit)
          rects += `<rect x="${x * cw + dx * (cw / 2)}" y="${y * ch + dy * (ch / 2)}" width="${cw / 2 + 0.3}" height="${ch / 2 + 0.3}"/>`;
      });
    }),
  );
  const svg = `<svg class="logo" width="${9 * cw}" height="${3 * ch}" ><g fill="#000">${bg}</g><g fill="#d77757">${rects}</g></svg>`;
  document.querySelectorAll('.logo').forEach((el) => (el.outerHTML = svg));
})();
