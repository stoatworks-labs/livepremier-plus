#!/usr/bin/env python3
"""
A virtual X-keys XKE-124 T-bar, made with Linux uhid, for driving LivePremier Plus's
REAL device host (devices/host.js, node-hid on hidraw) without a panel:
test/sim/xkeys-uhid.sim.test.js runs against it. It needs root for /dev/uhid and
the uhid module (on Ubuntu, linux-modules-extra-$(uname -r), then modprobe uhid).

  sudo python3 test/helpers/uhid-xkeys.py <control-fifo> <state-json> &

It behaves as test/helpers/fake-xkeys.js does and nothing more: answers the version
request (214) and Generate Data (177), sends a key report whenever a key or the
T-bar moves, and keeps every backlight and lamp it is sent. It chmods its hidraw
node so the logged-in user can open it, as devices/udev/71-xkeys.rules would.

Lines on the control FIFO: press N, release N, tap N, tbar V, unplug, replug, quit.
The state file is rewritten after every change:

  {"plugged", "hidraw", "opened", "closed", "outputs", "written": [[cmd, a, b], ...],
   "leds": {index: 0|1|2}, "banks": {bank: on}, "indicators": {"green", "red"}}

The panel goes when this process does: the kernel destroys a uhid device whose
/dev/uhid is closed.
"""
import json, os, select, struct, sys, time, glob

UHID_DESTROY, UHID_START, UHID_STOP, UHID_OPEN, UHID_CLOSE, UHID_OUTPUT = 1, 2, 3, 4, 5, 6
UHID_GET_REPORT, UHID_GET_REPORT_REPLY, UHID_CREATE2, UHID_INPUT2 = 9, 10, 11, 12
UHID_SET_REPORT, UHID_SET_REPORT_REPLY = 13, 14
EVENT_SIZE = 4380
BUS_USB = 3

VID, PID = 0x05F3, 1275          # XKE-124 T-bar, its first product id
B_BYTES, B_BITS, TBAR_BYTE = 16, 8, 28
UNIT_ID, FIRMWARE = 0, 38

# Vendor page, 32 bytes in, 35 bytes out, no report ids: as an X-keys' interface 0.
RDESC = bytes([
    0x06, 0x00, 0xFF,        # Usage Page (Vendor 0xFF00)
    0x09, 0x01,              # Usage (1)
    0xA1, 0x01,              # Collection (Application)
    0x15, 0x00,              #   Logical Minimum (0)
    0x26, 0xFF, 0x00,        #   Logical Maximum (255)
    0x75, 0x08,              #   Report Size (8)
    0x95, 0x20,              #   Report Count (32)
    0x09, 0x01,              #   Usage (1)
    0x81, 0x02,              #   Input (Data, Var, Abs)
    0x95, 0x23,              #   Report Count (35)
    0x09, 0x02,              #   Usage (2)
    0x91, 0x02,              #   Output (Data, Var, Abs)
    0xC0,                    # End Collection
])

fifo_path, state_path = sys.argv[1], sys.argv[2]

held, tbar = set(), 0
state = {"plugged": False, "hidraw": None, "opened": 0, "written": [], "leds": {}, "banks": {},
         "indicators": {"green": 0, "red": 0}, "closed": False, "started": False, "outputs": 0}


def save():
    tmp = state_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, state_path)


def write_event(fd, etype, payload):
    buf = struct.pack("<I", etype) + payload
    os.write(fd, buf + bytes(EVENT_SIZE - len(buf)))


def send_input(fd, data):
    data = bytes(data)
    write_event(fd, UHID_INPUT2, struct.pack("<H", len(data)) + data + bytes(4096 - len(data)))


def keys_report(generated=False):
    out = [0] * 32
    out[0] = UNIT_ID
    if generated:
        out[1] |= 2
    for k in held:
        x, y = (k - 1) // B_BITS, (k - 1) % B_BITS
        out[2 + x] |= 1 << y
    out[TBAR_BYTE] = tbar
    return out


def version_report():
    out = [0] * 32
    out[0], out[1], out[10], out[11], out[12] = UNIT_ID, 214, FIRMWARE, PID & 0xFF, PID >> 8
    return out


def on_output(fd, data):
    state["outputs"] += 1
    if len(data) == 36 and data[0] == 0:
        data = data[1:]          # the report id hidapi writes for a device without ids
    cmd, a, b = data[0], data[1], data[2]
    state["written"].append([cmd, a, b])
    state["written"] = state["written"][-400:]
    if cmd == 214:
        send_input(fd, version_report())
    elif cmd == 177:
        send_input(fd, keys_report(True))
    elif cmd == 179:
        state["indicators"]["green" if a == 6 else "red"] = b
    elif cmd == 181:
        state["leds"][str(a)] = b
    elif cmd == 182:
        state["banks"][str(a)] = b
        for i in list(state["leds"]):
            if (1 if int(i) >= 128 else 0) == a:
                state["leds"][i] = 1 if b else 0


def find_hidraw():
    for dev in glob.glob("/sys/class/hidraw/hidraw*/device/uevent"):
        with open(dev) as f:
            ev = f.read()
        if f"HID_ID=0003:{VID:08X}:{PID:08X}" in ev and "uhid" in os.path.realpath(dev):
            node = "/dev/" + dev.split("/")[4]
            return node if os.path.exists(node) else None   # udev makes the node a moment after sysfs
    return None


NAME = b"P. I. Engineering XKE-124 T-bar (uhid)"


def plug(fd):
    """Make the panel: a fresh one, its lamps dark, as when a real one is plugged in."""
    req = (NAME.ljust(128, b"\0") + b"lpp-test".ljust(64, b"\0") + b"".ljust(64, b"\0")
           + struct.pack("<HHIIII", len(RDESC), BUS_USB, VID, PID, 0x0100, 0) + RDESC.ljust(4096, b"\0"))
    write_event(fd, UHID_CREATE2, req)
    held.clear()
    state.update(plugged=True, hidraw=None, closed=False, leds={}, banks={}, indicators={"green": 0, "red": 0})


def unplug(fd):
    write_event(fd, UHID_DESTROY, b"")
    state.update(plugged=False, hidraw=None, closed=True)


def main():
    global tbar
    fd = os.open("/dev/uhid", os.O_RDWR | os.O_CLOEXEC)
    plug(fd)
    if not os.path.exists(fifo_path):
        os.mkfifo(fifo_path)
    os.chmod(fifo_path, 0o666)
    ctl = os.open(fifo_path, os.O_RDONLY | os.O_NONBLOCK)
    pending = b""
    deadline = time.time() + 5
    save()
    try:
        while True:
            if state["plugged"] and state["hidraw"] is None and time.time() < deadline:
                node = find_hidraw()
                try:
                    if node:
                        os.chmod(node, 0o666)
                        state["hidraw"] = node
                        save()
                except FileNotFoundError:
                    pass
            r, _, _ = select.select([fd, ctl], [], [], 0.1)
            if fd in r:
                ev = os.read(fd, EVENT_SIZE)
                etype = struct.unpack_from("<I", ev)[0]
                if etype == UHID_START:
                    state["started"] = True
                elif etype == UHID_OPEN:
                    state["opened"] += 1
                    state["closed"] = False
                elif etype == UHID_CLOSE:
                    state["closed"] = True
                elif etype == UHID_OUTPUT:
                    size = struct.unpack_from("<H", ev, 4 + 4096)[0]
                    on_output(fd, list(ev[4:4 + size]))
                elif etype == UHID_GET_REPORT:
                    rid = struct.unpack_from("<I", ev, 4)[0]
                    write_event(fd, UHID_GET_REPORT_REPLY, struct.pack("<IHH", rid, 5, 0) + bytes(4096))
                elif etype == UHID_SET_REPORT:
                    rid = struct.unpack_from("<I", ev, 4)[0]
                    write_event(fd, UHID_SET_REPORT_REPLY, struct.pack("<IH", rid, 0))
                save()
            if ctl in r:
                chunk = os.read(ctl, 4096)
                if not chunk:            # the writer went: reopen for the next one
                    os.close(ctl)
                    ctl = os.open(fifo_path, os.O_RDONLY | os.O_NONBLOCK)
                    continue
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    words = line.decode().split()
                    if not words:
                        continue
                    cmd = words[0]
                    if cmd == "quit":
                        return
                    if cmd == "unplug" and state["plugged"]:
                        unplug(fd)
                    elif cmd == "replug" and not state["plugged"]:
                        plug(fd)
                        deadline = time.time() + 5
                    elif not state["plugged"]:
                        pass
                    elif cmd in ("press", "tap", "release"):
                        if cmd != "release":
                            held.add(int(words[1]))
                            send_input(fd, keys_report())
                        if cmd != "press":
                            held.discard(int(words[1]))
                            send_input(fd, keys_report())
                    elif cmd == "tbar":
                        tbar = int(words[1])
                        send_input(fd, keys_report())
                    save()
    finally:
        os.close(fd)


main()
