#!/usr/bin/env python3
"""Add explicit runtime-role allowlists to the reviewed Cron registry."""

import json
from pathlib import Path


PRIMARY_ONLY_MARKERS = (
    '__heartbeat__', '__snapshot__', 'paper', 'p1_', 'gated_improvement',
    'microstructure', 'runtime_fee_auth', 'account', 'order', 'promotion',
)


def main() -> None:
    path = Path('ops/pipeline/cron_definitions.v1.json')
    document = json.loads(path.read_text(encoding='utf-8'))
    for job in document['jobs']:
        name = str(job.get('name', '')).lower()
        primary_only = any(marker in name for marker in PRIMARY_ONLY_MARKERS)
        job['allowedRuntimeRoles'] = ['primary'] if primary_only else ['primary', 'research']
    path.write_text(json.dumps(document, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
