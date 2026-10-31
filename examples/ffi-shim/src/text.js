// Our own JavaScript, shipped next to main.flow.

export const shout = (s) => String(s).toUpperCase() + "!";

export const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
