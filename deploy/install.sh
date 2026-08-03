#!/usr/bin/env bash
# Install the dashboard on an EC2 instance. Idempotent; safe to re-run for an upgrade.
#
# Expects the page to have been built already - dist/ has to exist. Building here would mean
# devDependencies and a toolchain on the instance that serves the approval screen, which is more
# software on that box than the job needs.
set -euo pipefail

APP=opt-dashboard
PREFIX=/opt/${APP}
ETC=/etc/${APP}
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

command -v node >/dev/null || { echo "node is not installed. See README, step 2." >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  echo "node ${NODE_MAJOR} is too old; 20 or newer is required" >&2
  exit 1
fi

if [[ ! -d ${SRC}/dist ]]; then
  cat >&2 <<EOF

No built page at ${SRC}/dist

Nothing has been installed. Build first, on a machine with the toolchain:

  npm ci
  npm run build

then copy the tree here and run this again.

EOF
  exit 1
fi

id -u "${APP}" &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin "${APP}"

install -d -o root -g root -m 0755 "${PREFIX}"
install -d -o root -g "${APP}" -m 0750 "${ETC}"

# The reference copy, refreshed every install so it tracks the code.
install -o root -g "${APP}" -m 0640 "${SRC}/deploy/dashboard.env.example" "${ETC}/dashboard.env.example"

# Refuse to continue without real configuration, and refuse before installing anything.
#
# The same reasoning as the listener: every value in the example is present and well formed, so a
# server started from it would come up, report active, and serve an empty list - which reads
# exactly like a system with nothing wrong. A first deploy to a fresh host would look like it
# worked. OPT_DASHBOARD_API_KEY is empty in the example on purpose, and the server refuses to
# start without it, but the check belongs here where it can say what to do.
if [[ ! -f ${ETC}/dashboard.env ]]; then
  cat >&2 <<EOF

No configuration at ${ETC}/dashboard.env

This host has never been configured. Nothing has been installed. Copy the example, fill it in,
then run this again:

  sudo cp ${ETC}/dashboard.env.example ${ETC}/dashboard.env
  sudo chown root:${APP} ${ETC}/dashboard.env
  sudo chmod 0640 ${ETC}/dashboard.env
  sudoedit ${ETC}/dashboard.env

OPT_DASHBOARD_API_KEY is empty in the example and has no default. Generate one:

  openssl rand -hex 32

EOF
  exit 1
fi

# Replace the code outright rather than merging into what is there. A leftover module from an
# earlier version still imports, and a leftover asset from an earlier build is still served.
rm -rf "${PREFIX}/server" "${PREFIX}/dist" "${PREFIX}/node_modules"
cp -r "${SRC}/server" "${PREFIX}/server"
cp -r "${SRC}/dist" "${PREFIX}/dist"
cp "${SRC}/package.json" "${PREFIX}/package.json"
[[ -f ${SRC}/package-lock.json ]] && cp "${SRC}/package-lock.json" "${PREFIX}/package-lock.json"

# Runtime dependencies only. The AWS SDK is the single one; react and the build toolchain are
# already baked into dist/ and have no business on this host.
if [[ -f ${PREFIX}/package-lock.json ]]; then
  ( cd "${PREFIX}" && npm ci --omit=dev --no-audit --no-fund )
else
  echo "no package-lock.json - installing from package.json, which does not pin transitively" >&2
  ( cd "${PREFIX}" && npm install --omit=dev --no-audit --no-fund )
fi

chown -R root:root "${PREFIX}"
chmod -R go-w "${PREFIX}"

# What is actually running on this host. Set by the deploy workflow to the commit it shipped;
# empty for a hand install, which is itself worth being able to see.
printf '%s\n' "${OPT_RELEASE:-unknown}" > "${PREFIX}/RELEASE"

install -o root -g root -m 0644 "${SRC}/deploy/${APP}.service" "/etc/systemd/system/${APP}.service"
systemctl daemon-reload
systemctl enable "${APP}"

echo
echo "installed. start with:  systemctl restart ${APP}"
echo "watch with:             journalctl -u ${APP} -f"
echo "check with:             curl -s localhost:\${OPT_PORT:-8080}/api/health"
