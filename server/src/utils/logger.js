/* Tiny leveled logger with timestamps - no external dep needed. */
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

const write = (level, tag, args) => {
  const prefix = `${stamp()} [${level}] ${tag}`;
  if (level === "ERROR") console.error(prefix, ...args);
  else if (level === "WARN") console.warn(prefix, ...args);
  else console.log(prefix, ...args);
};

export const logger = {
  info: (...a) => write("INFO", "api", a),
  warn: (...a) => write("WARN", "api", a),
  error: (...a) => write("ERROR", "api", a),
  tag(name) {
    return {
      info: (...a) => write("INFO", name, a),
      warn: (...a) => write("WARN", name, a),
      error: (...a) => write("ERROR", name, a),
    };
  },
};

export default logger;
