const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE_PATTERN = /(?<![\w.])\+?\d[\d\s().-]{6,}\d(?!\w)/g;

function looksLikePhoneNumber(candidate: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return false;
  const digits = candidate.replace(/\D/g, "").length;
  return digits >= 8 && digits <= 15;
}

/** Masks e-mail addresses (`[email]`) and phone numbers (`[phone]`). */
export function redactText(value: string): string {
  return value
    .replace(EMAIL_PATTERN, "[email]")
    .replace(PHONE_PATTERN, (match) => (looksLikePhoneNumber(match) ? "[phone]" : match));
}

/** Applies `redactText` to every string leaf of a JSON value. */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue(entry)]),
    );
  }
  return value;
}
