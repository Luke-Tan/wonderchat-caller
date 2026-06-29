/**
 * Tiny in-process metrics. No external deps — exposes a Prometheus-style text
 * exposition at /metrics. Good enough for a single-instance middleware; swap
 * for prom-client if you scale out.
 */

const counters: Record<string, number> = {
  inbound_calls_total: 0,
  retell_registration_success_total: 0,
  retell_registration_failure_total: 0,
  sip_dial_success_total: 0,
  sip_dial_failure_total: 0,
};

let activeCalls = 0;
let totalCompletedCalls = 0;
let totalDurationSeconds = 0;

export const metrics = {
  inc(name: keyof typeof counters, by = 1) {
    counters[name] += by;
  },
  callStarted() {
    activeCalls += 1;
  },
  callEnded(durationSeconds: number) {
    activeCalls = Math.max(0, activeCalls - 1);
    totalCompletedCalls += 1;
    totalDurationSeconds += Math.max(0, durationSeconds);
  },
  snapshot() {
    return {
      ...counters,
      active_calls: activeCalls,
      average_call_duration:
        totalCompletedCalls > 0 ? totalDurationSeconds / totalCompletedCalls : 0,
    };
  },
  /** Prometheus text exposition format. */
  render(): string {
    const snap = this.snapshot();
    const lines: string[] = [];
    for (const [k, v] of Object.entries(snap)) {
      const type = k.endsWith("_total") ? "counter" : "gauge";
      lines.push(`# TYPE ${k} ${type}`);
      lines.push(`${k} ${v}`);
    }
    return lines.join("\n") + "\n";
  },
};
