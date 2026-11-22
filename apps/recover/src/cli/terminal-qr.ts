import qrcode from 'qrcode-generator';

const QUIET_ZONE = 2;
const ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]+$/;

/**
 * A QR code for a terminal, two module rows per text line with half blocks. Light modules are drawn
 * as blocks, so the code reads dark-on-light on the usual dark terminal background.
 */
export const terminalQr = (value: string): string => {
  const qr = qrcode(0, 'M');
  qr.addData(value, ALPHANUMERIC.test(value) ? 'Alphanumeric' : 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  const size = count + QUIET_ZONE * 2;
  const light = (row: number, col: number): boolean => {
    const r = row - QUIET_ZONE;
    const c = col - QUIET_ZONE;
    if (r < 0 || c < 0 || r >= count || c >= count) return true;
    return !qr.isDark(r, c);
  };
  const lines: string[] = [];
  for (let row = 0; row < size; row += 2) {
    let line = '';
    for (let col = 0; col < size; col += 1) {
      const top = light(row, col);
      const bottom = row + 1 < size ? light(row + 1, col) : true;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
};
