[![Bounty](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/competitions/sokoban-solver-01-run-20261121)
[![Rank](https://make.fun/badge/sokoban-solver-01-run-20261121/stfu-onad/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/competitions/sokoban-solver-01-run-20261121)
[![Reward](https://make.fun/badge/sokoban-solver-01-run-20261121/stfu-onad/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/competitions/sokoban-solver-01-run-20261121)

# sokoban-rooms

A Sokoban solver for make.fun's sokoban-solver-01-run-20261121, written from scratch in one file, `main.ts` (Node 22, no dependencies).

How it works: the generator lays a hallway across the board with rooms off it, and a box pushed into the hallway can never come back, so each room is solved on its own and the push counts add up to the level's optimum. Rooms are found by cutting the dead squares of the player's row out of the floor and flood-filling what is left. Each room is solved with A* over pushes — a state is the sorted box squares plus the player's reachable region — with the cheapest box-to-goal assignment as an admissible heuristic, dead-square pruning, and frozen 2x2-block pruning. A whole-level A* is the fallback when a level does not split into rooms. Every budget is a node count, never the clock, and every tie-break follows a fixed order, so two runs answer byte for byte alike.

## Grade locally

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/sok-out node main.ts
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```
