# Egress Sentinel traffic sensor

This folder is the traffic sensor: a small program for a separate server that checks whether traffic actually passes through your VLESS exit nodes and reports the results to the Egress Sentinel monitor.

- Installation and configuration: [docs/SENSOR.md](../docs/SENSOR.md)
- На русском: [docs/SENSOR.ru.md](../docs/SENSOR.ru.md)

Quick check after configuring `config.json`:

```bash
node sensor.js --check
```
