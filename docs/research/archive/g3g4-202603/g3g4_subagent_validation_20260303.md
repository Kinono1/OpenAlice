# G3/G4 集中验证记录（OpenAlice，2026-03-03）

执行目录：`/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice`

## 执行结果

1. `python3 -m unittest scripts/tests/test_strategy_g3g4_iteration.py`
- 状态：通过
- 结果：`Ran 2 tests ... OK`

2. `python3 -m unittest scripts/tests/test_strategy_phaseb_family_search.py`
- 状态：通过
- 结果：`Ran 4 tests ... OK`

3. `python3 scripts/tests/test_strategy_g3g4_failure_breakdown.py`
- 状态：通过
- 结果：`Ran 1 test ... OK`

4. `python3 scripts/tests/test_strategy_protocol_ablation.py`
- 状态：通过
- 结果：`Ran 3 tests ... OK`

## 汇总
- 通过：4
- 失败：0
- 备注：本次验证基于当前工作树，未执行 commit/push。
