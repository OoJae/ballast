# Host A: the signing host

Host A runs the **keeper**, which signs decision records today and will sign Strike requests once holder accounts are bound. It also runs a **recorder**, whose recordings feed the keeper's Critic.

Since 2026-10-23 host A is a Tencent Lighthouse instance in **São Paulo, Brazil** (Ubuntu 24.04, 2 vCPU, 4 GB).

## Eligibility

Anything that signs Strike requests must run outside every jurisdiction on Strike's [restricted list](https://www.strikefinance.org/restricted). Checked 2026-10-23, list updated October 2026:
- Brazil is on neither the sanctioned nor the regulatory list.
- The host's egress IP geolocates to São Paulo, BR. This was checked from the host itself, against ipinfo.io.
- No VPN or proxy is involved.

Strike's page says the list "may not be exhaustive". Re-check it before arming.

`BALLAST_ELIGIBLE_HOST=1` in `keeper.env` records this attestation. The keeper refuses to load Strike keys without it.

## Layout

| Item             | Where                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service user     | `ballast`: a system user with no sudo, no login shell and a 0700 home                                                                              |
| Code             | `/home/ballast/ballast`, synced by `ops/deploy-signing-host.sh` (gitignored files never leave the laptop)                                          |
| Units            | `ballast-recorder.service`, `ballast-keeper.service` (system units, `User=ballast`, enabled at boot)                                               |
| Keys             | `/home/ballast/.ballast/host.kek` and `/home/ballast/.ballast/keys/daemon.json`. This host has its own KEK; the daemon key was re-sealed under it. |
| Not on this host | The operator key (it signs policies offline), the anchor keys, and any Strike or wallet key                                                        |
| Evidence DB      | `/home/ballast/ballast/data/ballast.sqlite`, migrated from the laptop with decisions 1–2 intact                                                    |
| Policies         | `/home/ballast/ballast/data/policies` (signed policy and renewal envelope)                                                                         |
| Health           | `curl -s http://127.0.0.1:9464/healthz` on the host (localhost only)                                                                               |

## Deploy or update

```sh
ops/deploy-signing-host.sh ubuntu@<host-a> sp
```

The script:
- creates the user if it is missing;
- syncs the code and installs dependencies with `pnpm install --frozen-lockfile`;
- writes both units, and restarts the recorder, plus the keeper if `keeper.env` exists.

`data/`, `deploy/*.env` and `~ballast/.ballast` are never touched.

## Keys and the keeper environment (by hand, once)

1. **Re-seal the daemon key under a fresh KEK for the host.** Do this locally in a 0700 temp folder, then pipe each file over SSH into `sudo -u ballast bash -c 'umask 077; cat > <path>'`. Delete the local temp copies afterwards.
2. **Write `deploy/keeper.env` the same way** (mode 0600). It names key files, never keys. Keep `DRY_RUN=true` and `BALLAST_ARM=0`.
3. **Move the evidence DB only with the old keeper stopped.** Use the SQLite backup API and compare sha256 on both ends. Then retire the old copy, so no second keeper can fork the decision chain.

## Checks

```sh
sudo systemctl status ballast-keeper ballast-recorder
sudo journalctl -u ballast-keeper -n 50 -o cat
curl -s http://127.0.0.1:9464/healthz    # ok, mode dry-run, decisionSeq, policy
```

## Anchoring

`ballast anchor` needs the daemon lock, so it runs on this host during a short keeper stop:

```sh
sudo systemctl stop ballast-keeper
# then run `ballast anchor` as the ballast user
sudo systemctl start ballast-keeper
```

The anchor wallet key is not on the host yet. Move it here, under this host's KEK, when daily anchoring starts.

## Still open

- **Host B (watchdog):** a second eligible host with a different provider, needed before any account is armed.
- **Hardening:**
  - Disable SSH password and root login.
  - Remove or disable the image's pre-installed agent gateway, which runs as `ubuntu` with sudo.
  - Enable the host firewall (the keeper exposes no inbound ports).
