const si = require('systeminformation');

class ProcessMonitor {
  constructor(store) {
    this.store = store;
    this._prevPids = null;
    this._prevMap  = {};
  }

  async collect() {
    const now = new Date().toISOString();
    let current;

    try {
      const result = await si.processes();
      current = result.list || [];
    } catch {
      return [];
    }

    // Build map keyed by pid
    const currentMap = {};
    for (const p of current) {
      if (!p.pid) continue;
      currentMap[p.pid] = {
        pid:     p.pid,
        name:    p.name   || '',
        path:    p.path   || '',
        command: p.command || '',
        user:    p.user   || '',
      };
    }

    // First run — just snapshot, no events
    if (this._prevPids === null) {
      this._prevPids = new Set(Object.keys(currentMap).map(Number));
      this._prevMap  = currentMap;
      return [];
    }

    const currentPids = new Set(Object.keys(currentMap).map(Number));
    const events = [];

    // Opened = in current but not in prev
    for (const pid of currentPids) {
      if (!this._prevPids.has(pid)) {
        const p = currentMap[pid];
        events.push({ event: 'open', pid, name: p.name, path: p.path, command: p.command, user: p.user, occurredAt: now });
      }
    }

    // Closed = in prev but not in current
    for (const pid of this._prevPids) {
      if (!currentPids.has(pid)) {
        const p = this._prevMap[pid];
        events.push({ event: 'close', pid, name: p.name, path: p.path, command: p.command, user: p.user, occurredAt: now });
      }
    }

    this._prevPids = currentPids;
    this._prevMap  = currentMap;
    return events;
  }
}

module.exports = { ProcessMonitor };
