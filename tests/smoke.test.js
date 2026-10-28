import Gio from 'gi://Gio';

const SCHEMA_ID = 'org.gnome.shell.extensions.todopet';
const UUID = 'todopet@trananhtung.github.io';

export default async function (t) {
    t.check(true, 'harness runs');

    // build/<uuid>/schemas, found relative to this file so the cwd does not matter.
    const repoRoot = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
    const schemaDir = repoRoot.resolve_relative_path(`build/${UUID}/schemas`).get_path();

    const source = Gio.SettingsSchemaSource.new_from_directory(
        schemaDir, Gio.SettingsSchemaSource.get_default(), false);
    const schema = source.lookup(SCHEMA_ID, false);
    if (!schema) {
        t.check(false, `schema ${SCHEMA_ID} found in ${schemaDir}`);
        return;
    }

    // A memory backend keeps the test away from the real dconf database.
    const settings = Gio.Settings.new_full(
        schema, Gio.memory_settings_backend_new(), '/org/gnome/shell/extensions/todopet/');
    t.eq(settings.get_int('daily-target'), 3, 'schema default daily-target');
}
