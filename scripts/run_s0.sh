#!/usr/bin/env bash
# run_s0.sh — stage-0 scoring run: Keplerian elements from 3D state vectors.
#
# Scores core/kepler.js cartesianToElements() on (A) a round-trip over every
# scripted body of the Sol Real document, (B) real JPL Horizons state vectors
# for comets/NEAs, and (C) the N-body planets against published J2000
# elements. Pass --offline to drop the Horizons suite. Exit code is the score.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/score-kepler.mjs "$@"
