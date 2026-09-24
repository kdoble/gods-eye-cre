// The app version shown in the CSV export header block (feature 1). Browser
// code cannot import root package.json (it is outside every owned package
// boundary, and the Vite config that could inject it at build time is off
// limits to this change), so this is a small hand-kept mirror of the
// "version" field in package.json. Update it alongside a version bump there.
export const APP_VERSION = '0.1.1';
