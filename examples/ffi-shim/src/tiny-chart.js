// Stand-in for an existing library: it has its own API, so `main.flow` declares
// the typed shape it needs and this file adapts the call. A real wrapper would
// import the package here (`import { Chart } from "tiny-chart"`).

export function renderChart(values, format) {
  const max = Math.max(1, ...values);
  return values
    .map((v) => {
      const width = Math.round((v / max) * 10);
      return format(v) + " " + "\u2588".repeat(width) + " " + "\u2591".repeat(10 - width);
    })
    .join("\n");
}
