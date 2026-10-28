// The names of the two keyring items (each one has the attribute item=<name>). Kept apart from services/secrets.js so
// the brain and the settings window can name a secret without loading libsecret (gir1.2-secret-1), which GNOME Shell
// does not depend on.
export const SECRET_TODOIST = 'todoist-token';
export const SECRET_ANTHROPIC = 'anthropic-key';
