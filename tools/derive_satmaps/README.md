# SatMap bake

One-time pipeline that derives 6 Gaea-style 2D CLUTs from real Earth data.

## Inputs (cached in `cache/`)

- **NASA Blue Marble Next Generation (August)** — https://visibleearth.nasa.gov/images/74092/august-blue-marble-next-generation-w-topography-and-bathymetry — download the 8192×4096 PNG and save as `cache/bluemarble_aug.png`
- **ETOPO1** — https://www.ngdc.noaa.gov/mgg/global/ — download `ETOPO1_Ice_g_geotiff.zip`, extract `ETOPO1_Ice_g.tif` to `cache/etopo1.tif`
- **Köppen-Geiger (Beck et al. 2018)** — http://www.gloh2o.org/koppen/ — download `Beck_KG_V1_present_0p0083.tif` to `cache/koppen.tif`

Total cache size: ~85 MB. The `cache/` directory is git-ignored.

## Run

```
cd tools/derive_satmaps
pip install -r requirements.txt
python derive.py
```

Outputs land in `apps/hayba/src/assets/satmaps/*.png` (6 PNGs, ~80 KB each).
