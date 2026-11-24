export function dateText(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "long",
        timeZone: "UTC",
      }).format(new Date(value))
    : null;
}
