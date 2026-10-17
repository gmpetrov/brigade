// What the API runs on a new workspace computer, through the provider. Generic
// Ubuntu with sudo: no provider names here.
import { createHash } from 'node:crypto'

/**
 * Root helper the runner may call through sudo, and nothing else as root. It
 * manages teammate Linux users and shares account logins with them without
 * ever reading a login file.
 */
export const TEAMMATE_HELPER = `#!/bin/sh
# Brigade teammate helper. Called by the brigade runner through sudo.
set -eu
GROUP=brigade-teammates
ACCOUNTS=/var/lib/brigade/accounts
fail() { echo "brigade-teammate: $1" >&2; exit 2; }
user_ok() { echo "$1" | grep -Eq '^bt-[a-z0-9]{1,28}$' || fail "bad user"; }
id_ok() { echo "$1" | grep -Eq '^[A-Za-z0-9_-]{1,64}$' || fail "bad id"; }
cred() { case "$1" in claude_code) echo .credentials.json ;; codex) echo auth.json ;; *) fail "bad provider" ;; esac; }

case "\${1:-}" in
  ensure-user) # <user>: a Linux user with a private home
    user_ok "$2"
    id "$2" >/dev/null 2>&1 || useradd -m -s /bin/bash -U -G "$GROUP" "$2"
    chmod 700 "/home/$2"
    ;;
  share-account) # <accountId>: after a sign-in, let teammate users use the login
    id_ok "$2"
    D="$ACCOUNTS/$2"
    [ -d "$D" ] || exit 0
    chown -R brigade:"$GROUP" "$D"
    chmod -R g+rwX,o-rwx "$D"
    find "$D" -type d -exec chmod g+s {} +
    ;;
  link-account) # <user> <accountId> <provider>: a private config dir sharing only the login file
    user_ok "$2"; id_ok "$3"; F=$(cred "$4")
    D="/home/$2/.accounts/$3"
    install -d -o "$2" -g "$2" -m 700 "/home/$2/.accounts" "$D"
    if [ ! -L "$D/$F" ]; then
      [ -f "$D/$F" ] && mv -f "$D/$F" "$ACCOUNTS/$3/$F" && chown brigade:"$GROUP" "$ACCOUNTS/$3/$F" && chmod 660 "$ACCOUNTS/$3/$F"
      ln -sfn "$ACCOUNTS/$3/$F" "$D/$F"
      chown -h "$2:$2" "$D/$F"
    fi
    ;;
  library-view) # <user>: the teammate's own library mirror, which only it (and the runner) reads
    user_ok "$2"
    id "$2" >/dev/null 2>&1 || fail "no such user"
    install -d -o brigade -g "$2" -m 2750 "/var/lib/brigade/library/$2"
    ;;
  browser) # <user> <port> <title> [url]: the teammate's Chrome on the desktop, its own profile
    user_ok "$2"
    echo "$3" | grep -Eq '^[0-9]{4,5}$' || fail "bad port"
    echo "$4" | grep -Eq '^[A-Za-z0-9 ._-]{1,60}$' || fail "bad title"
    URL="\${5:-}"
    if [ -n "$URL" ]; then echo "$URL" | grep -Eq '^https?://[^[:space:]]+$' || fail "bad url"; fi
    U=$(id -u "$2")
    # Only the teammate's own user may reach its browser's debugging port.
    for T in iptables ip6tables; do
      command -v "$T" >/dev/null || continue
      "$T" -C OUTPUT -o lo -p tcp --dport "$3" -m owner ! --uid-owner "$U" -j REJECT 2>/dev/null ||
        "$T" -I OUTPUT -o lo -p tcp --dport "$3" -m owner ! --uid-owner "$U" -j REJECT
    done
    # Its windows show on the computer's desktop, where a person can take over.
    AUTH=$(ps -o args= -C Xorg | sed -n 's/.* -auth \\([^ ]*\\).*/\\1/p' | head -1)
    DISPLAY=:0 XAUTHORITY="$AUTH" xhost "+SI:localuser:$2" >/dev/null || fail "no desktop"
    install -d -o "$2" -g "$2" -m 700 "/home/$2/.browser"
    # A resumed computer has a new hostname, and Chrome refuses a profile still locked by
    # its last run "on another computer". With none of the teammate's Chromes running,
    # that lock is stale: remove it, as the teammate.
    if ! pgrep -u "$2" -f "user-data-dir=/home/$2/.browser" >/dev/null; then
      runuser -u "$2" -- rm -f "/home/$2/.browser/SingletonLock" "/home/$2/.browser/SingletonCookie" \\
        "/home/$2/.browser/SingletonSocket"
    fi
    cd /
    # Chrome's output goes to ~/.browser.log, written as the teammate, so the runner can
    # say why it did not start.
    setsid -f runuser -u "$2" -- env -i HOME="/home/$2" USER="$2" LOGNAME="$2" DISPLAY=:0 \\
      PATH=/usr/bin:/bin LANG=C.UTF-8 sh -c 'exec "$@" >"$HOME/.browser.log" 2>&1' sh \\
      google-chrome --user-data-dir="/home/$2/.browser" \\
      --remote-debugging-port="$3" --no-first-run --no-default-browser-check \\
      --password-store=basic --class="brigade-$2" --window-name="$4" \${URL:+"$URL"} \\
      >/dev/null 2>&1 </dev/null
    ;;
  containers) # <user>: the teammate's own rootless Docker, under its user session; prints its uid
    user_ok "$2"
    U=$(id -u "$2") || fail "no such user"
    # No rootless Docker on this computer: nothing to start, and no uid printed.
    command -v dockerd-rootless-setuptool.sh >/dev/null && command -v newuidmap >/dev/null || exit 0
    grep -q "^$2:" /etc/subuid || fail "no subordinate ids for $2"
    # A user manager that outlives any login: it runs the daemon.
    loginctl enable-linger "$2"
    I=0
    while [ ! -S "/run/user/$U/bus" ] && [ $I -lt 60 ]; do sleep 0.25; I=$((I + 1)); done
    [ -S "/run/user/$U/bus" ] || fail "no user session for $2"
    cd /
    runuser -u "$2" -- env -i HOME="/home/$2" USER="$2" LOGNAME="$2" PATH=/usr/bin:/bin:/usr/sbin:/sbin \\
      XDG_RUNTIME_DIR="/run/user/$U" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$U/bus" \\
      sh -c 'systemctl --user is-active --quiet docker.service ||
        dockerd-rootless-setuptool.sh install --force >"$HOME/.docker-setup.log" 2>&1' ||
      fail "rootless Docker did not start for $2 (see its ~/.docker-setup.log)"
    I=0
    while [ ! -S "/run/user/$U/docker.sock" ] && [ $I -lt 120 ]; do sleep 0.25; I=$((I + 1)); done
    [ -S "/run/user/$U/docker.sock" ] || fail "no Docker socket for $2"
    echo "$U"
    ;;
  clipboard) # get|set: the desktop's clipboard as UTF-8, on stdout or from stdin
    AUTH=$(ps -o args= -C Xorg | sed -n 's/.* -auth \\([^ ]*\\).*/\\1/p' | head -1)
    [ -n "$AUTH" ] || fail "no desktop"
    export DISPLAY=:0 XAUTHORITY="$AUTH"
    case "\${2:-}" in
      get) timeout 3 xclip -o -selection clipboard 2>/dev/null || true ;;
      set) # both selections: Shift+Insert pastes PRIMARY in terminals, CLIPBOARD in browsers
        T=$(mktemp)
        trap 'rm -f "$T"' EXIT
        head -c 1000000 >"$T"
        for S in clipboard primary; do
          xclip -i -selection "$S" "$T" >/dev/null 2>&1 </dev/null
        done
        ;;
      *) fail "bad clipboard command" ;;
    esac
    ;;
  *) fail "unknown command" ;;
esac
`

/**
 * Root helper for each thread's own network: a network namespace per thread,
 * where its teammates' processes run (their commands, its preview, a person's
 * terminal), with a rootless Docker per teammate in it. Two threads can then
 * use the same ports, their containers' published ones too, without seeing
 * each other. The runner calls it through sudo; `run` keeps the runner's
 * environment (sudoers SETENV), as `sudo -E -u <teammate>` does.
 */
export const THREAD_HELPER = `#!/bin/sh
# Brigade thread helper. Called by the brigade runner through sudo.
set -eu
fail() { echo "brigade-thread: $1" >&2; exit 2; }
user_ok() { echo "$1" | grep -Eq '^bt-[a-z0-9]{1,28}$' && id "$1" >/dev/null 2>&1 || fail "bad user"; }
thread_ok() { echo "$1" | grep -Eq '^[A-Za-z0-9_-]{1,64}$' || fail "bad thread"; }
STATE=/run/brigade-threads
# systemd-resolved answers there too (DNSStubListenerExtra, from the setup): the host's
# loopback address the namespaces reach through their default route.
DNS=10.231.255.254
# 10.231.0.0/16 in /30s: thread n is 10.231.x.(y+2) in its namespace, .(y+1) on the host's side.
addr() { B=$(($1 * 4)); echo "10.231.$((B / 256)).$((B % 256 + $2))"; }
index() { cat "$STATE/$1" 2>/dev/null || fail "no network for thread $1"; }
netns() { [ -e "/run/netns/bt-$1" ] || fail "no network for thread $1"; echo "/run/netns/bt-$1"; }
# Threads reach the internet (masqueraded) and the host's DNS resolver, never each other.
host_rules() {
  ip addr add "$DNS/32" dev lo 2>/dev/null || true
  iptables -N BRIGADE-THREADS 2>/dev/null || true
  iptables -C FORWARD -j BRIGADE-THREADS 2>/dev/null || iptables -I FORWARD 1 -j BRIGADE-THREADS
  if ! iptables -C BRIGADE-THREADS -i 'btn+' -o 'btn+' -j DROP 2>/dev/null; then
    iptables -F BRIGADE-THREADS
    iptables -A BRIGADE-THREADS -i 'btn+' -o 'btn+' -j DROP
    iptables -A BRIGADE-THREADS -i 'btn+' -j ACCEPT
    iptables -A BRIGADE-THREADS -o 'btn+' -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  fi
  iptables -t nat -C POSTROUTING -s 10.231.0.0/16 ! -o 'btn+' -j MASQUERADE 2>/dev/null ||
    iptables -t nat -A POSTROUTING -s 10.231.0.0/16 ! -o 'btn+' -j MASQUERADE
  for P in udp tcp; do
    iptables -C INPUT -i 'btn+' -d "$DNS" -p $P --dport 53 -j ACCEPT 2>/dev/null ||
      iptables -I INPUT 1 -i 'btn+' -d "$DNS" -p $P --dport 53 -j ACCEPT
  done
}

case "\${1:-}" in
  up) # <thread>: its network namespace, made if needed; prints its address there
    thread_ok "$2"
    install -d -m 755 "$STATE"
    exec 9>"$STATE/.lock"
    flock 9
    host_rules
    if [ -f "$STATE/$2" ] && [ -e "/run/netns/bt-$2" ]; then
      addr "$(index "$2")" 2
      exit 0
    fi
    I=1
    while [ -e "/sys/class/net/btn$I" ] || grep -qsx "$I" "$STATE"/*; do I=$((I + 1)); done
    [ "$I" -lt 16383 ] || fail "no address left"
    H=$(addr "$I" 1)
    G=$(addr "$I" 2)
    N="bt-$2"
    ip netns del "$N" 2>/dev/null || true
    ip netns add "$N"
    ip link add "btn$I" type veth peer name "btp$I"
    ip link set "btp$I" netns "$N"
    ip addr add "$H/30" dev "btn$I"
    sysctl -qw "net.ipv4.conf.btn$I.route_localnet=1"
    ip link set "btn$I" up
    ip -n "$N" link set lo up
    ip -n "$N" link set "btp$I" name eth0
    ip -n "$N" addr add "$G/30" dev eth0
    ip -n "$N" link set eth0 up
    ip -n "$N" route add default via "$H"
    ip netns exec "$N" sysctl -qw net.ipv4.conf.eth0.route_localnet=1
    # What the host sends to its address reaches its loopback: an app listening on localhost
    # answers the runner (its preview's proxy, the harness's bridge).
    ip netns exec "$N" iptables -t nat -A PREROUTING -i eth0 -d "$G" -p tcp -j DNAT --to-destination 127.0.0.1
    # /etc/resolv.conf names systemd-resolved's stub (127.0.0.53), which is the host's.
    for P in udp tcp; do
      ip netns exec "$N" iptables -t nat -A OUTPUT -d 127.0.0.53 -p $P --dport 53 -j DNAT --to-destination "$DNS"
    done
    ip netns exec "$N" iptables -t nat -A POSTROUTING -o eth0 -s 127.0.0.0/8 -j SNAT --to-source "$G"
    echo "$I" >"$STATE/$2"
    echo "$G"
    ;;
  run) # <thread> <user> <command>...: the command as the teammate, in the thread's namespace
    thread_ok "$2"
    user_ok "$3"
    N=$(netns "$2")
    U=$3
    shift 3
    # sudo set USER and LOGNAME to its target, this helper's root: the teammate's, as with sudo -u.
    exec nsenter --net="$N" -- setpriv --reuid="$U" --regid="$U" --init-groups --inh-caps=-all -- \\
      env USER="$U" LOGNAME="$U" "$@"
    ;;
  docker) # <thread> <user>: the teammate's rootless Docker in the thread's namespace, started if
    # needed (its published ports are the thread's); prints its socket. Nothing without Docker.
    thread_ok "$2"
    user_ok "$3"
    N=$(netns "$2")
    command -v dockerd-rootless.sh >/dev/null && command -v newuidmap >/dev/null || exit 0
    grep -q "^$3:" /etc/subuid || fail "no subordinate ids for $3"
    R="/run/brigade-docker/$2/$3"
    UNIT="brigade-docker-$2-$3"
    if ! systemctl is-active --quiet "$UNIT"; then
      install -d -m 755 /run/brigade-docker "/run/brigade-docker/$2"
      install -d -o "$3" -g "$3" -m 700 "$R"
      D="/home/$3/.local/share/brigade-docker/$2"
      runuser -u "$3" -- mkdir -p "$D"
      systemctl reset-failed "$UNIT" 2>/dev/null || true
      # Its own unit: it outlives the runner's restarts. No systemd of the teammate's to manage
      # cgroups from there, hence cgroupfs (containers without resource limits).
      systemd-run --quiet --unit="$UNIT" --collect -p NetworkNamespacePath="$N" \\
        -p User="$3" -p Group="$3" -p Delegate=yes -p KillMode=mixed \\
        -E XDG_RUNTIME_DIR="$R" -E HOME="/home/$3" -E PATH=/usr/bin:/bin:/usr/sbin:/sbin \\
        dockerd-rootless.sh --data-root="$D" --exec-opt native.cgroupdriver=cgroupfs
    fi
    I=0
    while [ ! -S "$R/docker.sock" ] && [ $I -lt 120 ]; do sleep 0.25; I=$((I + 1)); done
    [ -S "$R/docker.sock" ] || fail "Docker did not start for $3 in thread $2 (journalctl -u $UNIT)"
    echo "$R/docker.sock"
    ;;
  docker-stop) # <thread> <user> [purge]: that Docker stopped, its containers with it; with purge,
    # its images, containers and volumes deleted
    thread_ok "$2"
    user_ok "$3"
    systemctl stop "brigade-docker-$2-$3" 2>/dev/null || true
    rm -rf "/run/brigade-docker/$2/$3"
    D="/home/$3/.local/share/brigade-docker/$2"
    if [ "\${4:-}" = purge ] && [ -d "$D" ]; then
      # As the teammate, mapped to its subordinate ids as Docker was: no more than it can reach.
      T=$(mktemp -d)
      chown "$3" "$T"
      runuser -u "$3" -- env XDG_RUNTIME_DIR="$T" rootlesskit --state-dir="$T/rk" rm -rf -- "$D"
      rm -rf "$T"
    fi
    ;;
  docker-freeze) # <thread> <user>: that Docker frozen, its containers with it (its thread's preview
    # is): no CPU, and its memory given back to swap, in 10 s at most (the kernel may go on
    # forever toward what it cannot free). docker pause cannot: it runs without cgroups of its own.
    thread_ok "$2"
    user_ok "$3"
    UNIT="brigade-docker-$2-$3.service"
    systemctl is-active --quiet "$UNIT" || exit 0
    systemctl freeze "$UNIT"
    C="/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$UNIT")"
    timeout 10 sh -c 'echo "$1" >"$0"' "$C/memory.reclaim" "$(cat "$C/memory.current")" 2>/dev/null || true
    ;;
  docker-thaw) # <thread> <user>
    thread_ok "$2"
    user_ok "$3"
    systemctl thaw "brigade-docker-$2-$3.service" 2>/dev/null || true
    ;;
  browser) # <thread> <user>: in the thread's namespace, the teammate's browser port (the teammate
    # helper's \`browser\`) reaches its Chrome on the host's loopback, for the teammate's user only
    thread_ok "$2"
    user_ok "$3"
    I=$(index "$2")
    H=$(addr "$I" 1)
    N="bt-$2"
    P=$((20000 + $(id -u "$3")))
    T() { ip netns exec "$N" iptables "$@"; }
    T -t nat -C OUTPUT -d 127.0.0.1 -p tcp --dport "$P" -m owner --uid-owner "$3" -j DNAT --to-destination "$H" 2>/dev/null ||
      T -t nat -A OUTPUT -d 127.0.0.1 -p tcp --dport "$P" -m owner --uid-owner "$3" -j DNAT --to-destination "$H"
    T -C OUTPUT -d "$H" -p tcp --dport "$P" -m owner ! --uid-owner "$3" -j REJECT 2>/dev/null ||
      T -A OUTPUT -d "$H" -p tcp --dport "$P" -m owner ! --uid-owner "$3" -j REJECT
    iptables -t nat -C PREROUTING -i "btn$I" -d "$H" -p tcp --dport "$P" -j DNAT --to-destination 127.0.0.1 2>/dev/null ||
      iptables -t nat -A PREROUTING -i "btn$I" -d "$H" -p tcp --dport "$P" -j DNAT --to-destination 127.0.0.1
    iptables -C INPUT -i "btn$I" -d 127.0.0.1 -p tcp --dport "$P" -j ACCEPT 2>/dev/null ||
      iptables -I INPUT 1 -i "btn$I" -d 127.0.0.1 -p tcp --dport "$P" -j ACCEPT
    ;;
  *) fail "unknown command" ;;
esac
`

/**
 * The root-owned parts of a workspace computer that change with Brigade: the
 * teammate and thread helpers, and the library folder. Run by the bootstrap,
 * and again on any computer whose runner reports another stamp (a runner
 * update cannot change root-owned files).
 */
const SETUP = `set -eu
getent group brigade-teammates >/dev/null || sudo groupadd brigade-teammates
sudo tee /usr/local/sbin/brigade-teammate >/dev/null <<'HELPER'
${TEAMMATE_HELPER}HELPER
sudo chmod 755 /usr/local/sbin/brigade-teammate
# Each thread's own network (the thread helper). Its \`run\` passes the runner's environment on,
# as sudo -E -u <teammate> does: sudo still drops what could change the helper itself (LD_*).
sudo tee /usr/local/sbin/brigade-thread >/dev/null <<'HELPER'
${THREAD_HELPER}HELPER
sudo chmod 755 /usr/local/sbin/brigade-thread
sudo tee /etc/sudoers.d/brigade-thread >/dev/null <<'SUDOERS'
brigade ALL=(root) NOPASSWD:SETENV: /usr/local/sbin/brigade-thread
SUDOERS
sudo chmod 440 /etc/sudoers.d/brigade-thread
sudo visudo -cq
# The threads' namespaces reach the host's resolver at an address of its own: its stub on
# 127.0.0.53 answers only the host's loopback.
RESOLVED='[Resolve]
DNSStubListenerExtra=10.231.255.254'
if [ -d /etc/systemd/resolved.conf.d ] || systemctl is-active --quiet systemd-resolved; then
  if [ "$(cat /etc/systemd/resolved.conf.d/brigade-threads.conf 2>/dev/null)" != "$RESOLVED" ]; then
    sudo install -d /etc/systemd/resolved.conf.d
    echo "$RESOLVED" | sudo tee /etc/systemd/resolved.conf.d/brigade-threads.conf >/dev/null
    sudo systemctl try-restart systemd-resolved
  fi
fi
# Containers for teammates: each runs its own rootless Docker (the helper's \`containers\`),
# never the root daemon, whose socket would make it root. Where Docker is installed.
if command -v dockerd-rootless-setuptool.sh >/dev/null; then
  NEED=""
  for P in uidmap slirp4netns dbus-user-session; do dpkg -s "$P" >/dev/null 2>&1 || NEED="$NEED $P"; done
  if [ -n "$NEED" ]; then
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $NEED >/dev/null
  fi
  # Ubuntu 24.04 may restrict user namespaces to profiled programs: allow rootlesskit's.
  if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] &&
    [ ! -f /etc/apparmor.d/brigade-rootlesskit ]; then
    sudo tee /etc/apparmor.d/brigade-rootlesskit >/dev/null <<'APPARMOR'
abi <abi/4.0>,
include <tunables/global>

/usr/bin/rootlesskit flags=(unconfined) {
  userns,
  include if exists <local/brigade-rootlesskit>
}
APPARMOR
    sudo apparmor_parser -r /etc/apparmor.d/brigade-rootlesskit
  fi
fi
# The workspace library, mirrored by the runner: one folder per teammate user, made by the
# helper, holding only what that teammate may read. Teammates pass through, never list it.
sudo install -d -o brigade -g brigade-teammates -m 2710 /var/lib/brigade/library
sudo chmod 2710 /var/lib/brigade/library
# A stop or reboot signals the runner alone: it freezes running turns and stops their harnesses
# itself, so they go on after the restart. Whatever is left after a minute is killed.
sudo install -d /etc/systemd/system/brigade-runner.service.d
sudo tee /etc/systemd/system/brigade-runner.service.d/stop.conf >/dev/null <<'UNIT'
[Service]
KillMode=mixed
TimeoutStopSec=60
UNIT
# Previews in cgroups of their own (the runner's preview-cgroup.ts): the runner's cgroup is
# delegated to it, and it starts in runner/ beside them. When memory runs out, a preview goes
# before the runner or a turn: the runner and its harnesses inherit a low OOM score, and each
# preview raises its own. A process the kernel kills no longer stops the whole service (and
# every turn with it), as the default OOMPolicy=stop did. Taken up at the runner's next start.
sudo tee /etc/systemd/system/brigade-runner.service.d/cgroups.conf >/dev/null <<'UNIT'
[Service]
Delegate=memory cpu pids
DelegateSubgroup=runner
OOMScoreAdjust=-500
OOMPolicy=continue
UNIT
# Swap for frozen previews (the runner's previews.ts gives their memory back to it): twice the
# memory, at most 16 GiB and a quarter of the disk's free space, which thread folders need (the
# runner's folders.ts does not trim them for it). Made at each boot: a resume brings back neither
# files at the root nor fstab lines, so it costs nothing at stop or resume. Used before the
# image's own /swapfile.
sudo tee /usr/local/sbin/brigade-swap >/dev/null <<'SWAP'
#!/bin/sh
set -eu
F=/brigade.swap
swapon --show=NAME --noheadings | grep -qx "$F" && exit 0
HAD=$(stat -c %s "$F" 2>/dev/null || echo 0)
# Free space in GiB, with the space of a swap file from an earlier boot, made again here.
FREE=$(( $(df --output=avail -B1 / | tail -1 | tr -dc 0-9) / 1073741824 + HAD / 1073741824 ))
GIB=$(awk '/^MemTotal:/ { print int($2 / 1048576 + 0.5) * 2 }' /proc/meminfo)
[ "$GIB" -le 16 ] || GIB=16
[ "$GIB" -le $((FREE / 4)) ] || GIB=$((FREE / 4))
[ "$GIB" -ge 2 ] || { rm -f "$F"; echo "no room for swap"; exit 0; }
if [ "$HAD" -ne $((GIB * 1073741824)) ]; then
  rm -f "$F"
  fallocate -l "$GIB"G "$F"
fi
chmod 600 "$F"
mkswap "$F" >/dev/null
swapon --priority 10 "$F"
SWAP
sudo chmod 755 /usr/local/sbin/brigade-swap
sudo tee /etc/systemd/system/brigade-swap.service >/dev/null <<'UNIT'
[Unit]
Description=Swap for Brigade's frozen previews
After=local-fs.target
Before=brigade-runner.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/brigade-swap

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable brigade-swap.service 2>/dev/null
sudo systemctl restart brigade-swap.service
`

/** Identifies the current setup; the runner reports the one last applied. */
export const SETUP_SHA = createHash('sha256').update(SETUP).digest('hex')

export const setupScript = () =>
  `${SETUP}echo ${SETUP_SHA} | sudo tee /var/lib/brigade/setup >/dev/null
`

const install = '/opt/brigade'
const runner = `${install}/bin/brigade-runner`

/**
 * Reinstall the runner from the API's bundle and restart it. For runners too
 * old to update themselves; newer ones run the installer on their own.
 */
export const reinstallScript = (apiUrl: string) => `set -eu
sudo -u brigade -H env BRIGADE_INSTALL_DIR=${install} sh -c 'curl -fsSL ${apiUrl}/runner/install.sh | sh'
sudo systemctl restart brigade-runner
`

/** Install the runner under its own Linux user, as a service that survives stop and resume. */
export function bootstrapScript(input: { apiUrl: string; code: string }) {
  return `set -eu
id brigade >/dev/null 2>&1 || sudo useradd -m -s /bin/bash brigade
getent group brigade-teammates >/dev/null || sudo groupadd brigade-teammates

# Runner and Node.js in /opt (readable by teammate users); its own data stays private.
sudo install -d -o brigade -g brigade -m 755 ${install}
sudo -u brigade -H env BRIGADE_INSTALL_DIR=${install} sh -c 'curl -fsSL ${input.apiUrl}/runner/install.sh | sh'
sudo install -d -o brigade -g brigade-teammates -m 2770 /var/lib/brigade/accounts
sudo chmod 755 /var/lib/brigade

${setupScript()}
# Teammate users: the runner may create them, run as them, and share logins with them. Nothing else as root.
sudo tee /etc/sudoers.d/brigade-runner >/dev/null <<'SUDOERS'
Defaults:brigade !requiretty
brigade ALL=(root) NOPASSWD: /usr/local/sbin/brigade-teammate
brigade ALL=(%brigade-teammates) NOPASSWD:SETENV: ALL
SUDOERS
sudo chmod 440 /etc/sudoers.d/brigade-runner
sudo visudo -cq

sudo -u brigade -H ${runner} link ${input.code} --api ${input.apiUrl} --name 'Cloud computer'
sudo tee /etc/systemd/system/brigade-runner.service >/dev/null <<'UNIT'
[Unit]
Description=Brigade runner
After=network-online.target
Wants=network-online.target

[Service]
User=brigade
WorkingDirectory=/home/brigade
Environment=HOME=/home/brigade
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=BRIGADE_CLOUD=1
Environment=BRIGADE_ACCOUNTS_DIR=/var/lib/brigade/accounts
Environment=BRIGADE_SHIM_DIR=${install}/bin/shims
ExecStart=${runner} start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable brigade-runner
sudo systemctl restart brigade-runner
`
}
