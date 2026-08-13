# 덧쓴 기록관 원본 에셋

내장 이미지 생성기로 제작한 원본을 런타임 아틀라스로 정규화하기 위한 소스입니다.

- `walk-transparent.png`: 동일 캐릭터·동일 비율을 유지한 S, SW, W, NW, N, NE, E, SE 8방향 × 4보행 프레임. 검붉은 기록관 로브, 청록 원고 조각, 자홍 잉크 장식, 투명 배경.
- `patterns-source.png`: 삭제선 추적, 복원선 역행, 교정 경로용 자홍·청록 마법 문양 4×2 프레임. 투명 배경과 넉넉한 셀 여백.

재생성:

```powershell
python scripts/build_palimpsest_archivist_assets.py
```
