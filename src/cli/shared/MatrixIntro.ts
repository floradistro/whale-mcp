/**
 * Matrix Rain Intro — green digital rain before chat starts
 */

import chalk from "chalk";

const CHARS = "ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍ0123456789ABCDEFZ";

const green0 = chalk.hex("#003B00");
const green1 = chalk.hex("#008F11");
const green2 = chalk.hex("#00FF41");
const white  = chalk.hex("#FFFFFF");
const brand  = chalk.hex("#00FF41").bold;

interface Drop {
  y: number;
  speed: number;
  trail: number;
}

function randChar(): string {
  return CHARS[Math.floor(Math.random() * CHARS.length)];
}

export async function matrixIntro(durationMs = 2200): Promise<void> {
  return new Promise((resolve) => {
    const cols = process.stdout.columns || 80;
    const rows = Math.min((process.stdout.rows || 24) - 1, 24);

    const drops: Drop[] = Array.from({ length: cols }, () => ({
      y: Math.random() * -rows * 1.5,
      speed: 0.3 + Math.random() * 0.7,
      trail: 4 + Math.floor(Math.random() * 10),
    }));

    // Hide cursor, clear screen
    process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");

    const start = Date.now();
    const fadeStart = durationMs * 0.65;

    const tick = setInterval(() => {
      const elapsed = Date.now() - start;
      const fading = elapsed > fadeStart;

      let output = "\x1b[H";

      for (const d of drops) {
        d.y += d.speed;
        if (d.y - d.trail > rows + 5) {
          if (fading) {
            d.y = -999;
          } else {
            d.y = Math.random() * -8;
            d.speed = 0.3 + Math.random() * 0.7;
            d.trail = 4 + Math.floor(Math.random() * 10);
          }
        }
      }

      for (let r = 0; r < rows; r++) {
        let line = "";
        for (let c = 0; c < cols; c++) {
          const d = drops[c];
          const dist = Math.floor(d.y) - r;

          if (dist < 0 || dist > d.trail) {
            line += " ";
          } else {
            const ch = randChar();
            if (dist === 0) line += white(ch);
            else if (dist < d.trail * 0.3) line += green2(ch);
            else if (dist < d.trail * 0.6) line += green1(ch);
            else line += green0(ch);
          }
        }
        output += line + (r < rows - 1 ? "\n" : "");
      }

      process.stdout.write(output);

      if (elapsed >= durationMs) {
        clearInterval(tick);

        // Flash brand in center
        process.stdout.write("\x1b[2J\x1b[H");
        const label = "◆ whale code";
        const brandRow = Math.floor(rows / 2);
        const brandCol = Math.max(1, Math.floor((cols - label.length) / 2));
        process.stdout.write(`\x1b[${brandRow};${brandCol}H`);
        process.stdout.write(brand(label));

        setTimeout(() => {
          process.stdout.write("\x1b[2J\x1b[H\x1b[?25h");
          resolve();
        }, 700);
      }
    }, 50);
  });
}
