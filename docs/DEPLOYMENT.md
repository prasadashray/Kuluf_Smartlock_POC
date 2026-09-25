# Deployment — public cloud VM (Phase D)

Goal: a server the lock can reach over the Airtel mobile network. Only the device TCP port is public; the API and
dashboard stay on the VM's localhost and are reached through an SSH tunnel.

## 1. VM requirements

| Item | Recommendation |
|---|---|
| Provider/region | Any (AWS, Azure, GCP, DigitalOcean, …). Prefer an **India region (e.g. Mumbai)**: lower latency to Airtel, and keeps location data in India (TDD §12.2) |
| Size | 1–2 vCPU, 2 GB RAM, 20 GB disk is ample for the POC |
| OS | Ubuntu 24.04 LTS |
| Public IP | **Static** (Elastic/Reserved IP) — the lock will be configured with this address |
| Inbound firewall / security group | TCP **6808** from anywhere (mobile-network source IPs vary); TCP 22 from your office/home IP only. Nothing else |
| Outbound | default (allow) |

## 2. Install (on the VM)

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
```

## 3. Copy the project

From the development PC (the repository is not on a remote yet):

```powershell
git -C C:\Users\SmartSkale\Desktop\Kuluf_Smartlock_POC archive --format=tar.gz -o poc.tar.gz HEAD   # after the first commit
scp poc.tar.gz <user>@<vm-ip>:~/
```
(or copy the folder without `node_modules`, `.env`, `captures`). On the VM:

```bash
mkdir -p ~/kuluf-poc && tar -xzf ~/poc.tar.gz -C ~/kuluf-poc && cd ~/kuluf-poc
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD (long random), DATABASE_URL is overridden inside compose,
# keep TCP_PORT=6808, API_HOST=127.0.0.1, optionally API_TOKEN
```

## 4. Start (database + server + dashboard; the simulator is NOT started on the VM)

```bash
docker compose --profile full up -d --build db server dashboard
docker compose logs -f server        # watch for "TT808ELOCK TCP listener on 0.0.0.0:6808"
```

Migrations run automatically at server start. Raw traffic is appended to `~/kuluf-poc/captures/traffic.jsonl`.

## 5. Verify reachability before touching the lock

From a machine **outside** the VM's network (e.g. the dev PC):

```powershell
Test-NetConnection <vm-ip> -Port 6808          # TcpTestSucceeded : True
node simulator/simulate-device.js --host <vm-ip> --port 6808 --device-id 000099990001 --lock-id 99990001 --exit-after 20
```
The simulated device should appear in the dashboard; delete nothing — it is harmless test data (terminal 000099990001).

## 6. Operator access (SSH tunnel)

```powershell
ssh -L 8080:127.0.0.1:8080 -L 3000:127.0.0.1:3000 <user>@<vm-ip>
# dashboard: http://localhost:8080     API: http://localhost:3000/api/health
```

## 7. Pointing the lock at the VM

Values to configure in the lock (method: vendor questions A1–A4): main server = `<vm-ip>`, TCP port = `6808`, APN =
as required by the Airtel SIM. Record the original values first (vendor A3 / `diagnostics/query-params` once it
is connected to us). Then follow `docs/HARDWARE_VALIDATION.md` §5.

## 8. Operations

| Task | Command |
|---|---|
| Status | `docker compose ps` |
| Server log | `docker compose logs -f server` |
| Restart server | `docker compose restart server` |
| Stop everything (data kept) | `docker compose --profile full stop` |
| DB shell | `docker compose exec db psql -U indialock indialock` |
| Backup | `docker compose exec db pg_dump -U indialock indialock > backup.sql` |

Security: the protocol is unencrypted and the API has no user accounts. Keep 3000/8080 closed to the internet,
restrict SSH, and treat `captures/` and `message_log` as sensitive (they contain keys and locations).
