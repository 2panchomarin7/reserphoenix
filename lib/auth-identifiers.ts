const USER_EMAIL_DOMAIN = "reserphoenix.local";

export function normalizeHomeLogin(label: string) {
  return label
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

export function homeLabelToEmail(label: string) {
  const login = normalizeHomeLogin(label);

  if (!login) {
    throw new Error("El piso no puede estar vacío.");
  }

  return `${login}@${USER_EMAIL_DOMAIN}`;
}
