const fs = require('fs');
const path = require('path');

function createLogger(logPath) {
  const recent = [];
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  function write(level, message, details) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: String(message || ''),
      ...(details ? { details } : {})
    };
    try {
      fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {}
    if (['error', 'warn'].includes(level)) {
      recent.unshift(entry);
      recent.length = Math.min(recent.length, 50);
    }
  }

  return {
    info: (message, details) => write('info', message, details),
    warn: (message, details) => write('warn', message, details),
    error: (message, details) => write('error', message, details),
    recentErrors: () => [...recent]
  };
}

module.exports = { createLogger };
