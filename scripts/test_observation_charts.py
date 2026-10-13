"""Decoder and analysis checks for observation charts; no network required."""
import gzip
import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest

import eccodes as ec
import numpy as np
from netCDF4 import Dataset

spec = importlib.util.spec_from_file_location('charts', Path(__file__).with_name('build_observation_charts.py'))
charts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(charts)
TIME = datetime(2026, 10, 13, 3, tzinfo=timezone.utc)


class ObservationTests(unittest.TestCase):
    def test_mslp_qnh_quality_and_time_are_kept_distinct(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'observations.nc'
            with Dataset(path, 'w') as dataset:
                dataset.createDimension('recNum', 3)
                dataset.createDimension('nameLength', 4)
                for key, values in {
                    'timeObs': [TIME.timestamp(), TIME.timestamp(), (TIME + timedelta(hours=2)).timestamp()],
                    'latitude': [20, 21, 22], 'longitude': [70, 71, 72],
                    'temperature': [293.15, 295.15, 290.15],
                    'dewpoint': [283.15, 294.15, 280.15],
                    'altimeter': [101600, 101800, 101500],
                    'seaLevelPress': [101200, 100000, 101100],
                    'windSpeed': [5, 6, 7], 'windDir': [90, 180, 270],
                }.items():
                    dataset.createVariable(key, 'f8', ('recNum',))[:] = values
                dataset.createVariable('seaLevelPressDD', 'S1', ('recNum',))[:] = np.array([b'V', b'X', b'V'])
                dataset.createVariable('dewpointDD', 'S1', ('recNum',))[:] = np.array([b'V', b'X', b'V'])
                names = dataset.createVariable('stationName', 'S1', ('recNum', 'nameLength'))
                names[:] = np.array([[bytes([x]) for x in name] for name in (b'AAAA', b'BBBB', b'CCCC')], dtype='S1')
            rows = charts.decode_surface_nc(gzip.compress(path.read_bytes()), 'METAR', TIME)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['mslp_hpa'], 1012)
        self.assertEqual(rows[0]['qnh_hpa'], 1016)
        self.assertIsNone(rows[1]['mslp_hpa'])
        self.assertEqual(rows[0]['temperature_c'], 20)
        self.assertEqual(rows[0]['dewpoint_c'], 10)
        self.assertIsNone(rows[1]['dewpoint_c'])

    def test_bufr_subsets_stay_aligned_for_both_encodings(self):
        for compressed in (0, 1):
            handle = ec.codes_bufr_new_from_samples('BUFR4')
            try:
                ec.codes_set(handle, 'numberOfSubsets', 2)
                ec.codes_set(handle, 'compressedData', compressed)
                ec.codes_set_array(handle, 'unexpandedDescriptors', [1001, 1002, 4001, 4002, 4003, 4004, 4005, 5001, 6001, 12101, 12103, 10051, 11001, 11002])
                ec.codes_set(handle, 'unpack', 1)
                for key, values in {
                    'blockNumber': [42, 42], 'stationNumber': [1, 2],
                    'year': [2026, 2026], 'month': [10, 10], 'day': [13, 13],
                    'hour': [3, 3], 'minute': [0, 0],
                    'latitude': [20, 30], 'longitude': [70, 80],
                    'airTemperature': [293.15, 283.15],
                    'dewpointTemperature': [283.15, 282.15],
                    'pressureReducedToMeanSeaLevel': [101200, 100500],
                    'windDirection': [90, 270], 'windSpeed': [5, 10],
                }.items():
                    ec.codes_set_array(handle, key, values)
                ec.codes_set(handle, 'pack', 1)
                rows = charts.decode_synop(ec.codes_get_message(handle), TIME)
            finally:
                ec.codes_release(handle)
            self.assertEqual([row['station'] for row in rows], ['42001', '42002'])
            self.assertEqual([row['mslp_hpa'] for row in rows], [1012, 1005])
            self.assertEqual([row['latitude'] for row in rows], [20, 30])
            self.assertEqual([row['dewpoint_c'] for row in rows], [10, 9])

    def test_moving_platform_only_uses_nearest_report(self):
        base = {'station': 'SHIP1', 'latitude': 20., 'longitude': 70., 'source': 'NOAA MADIS maritime'}
        rows = [dict(base, observed_at=charts.iso(TIME)), dict(base, longitude=70.2, observed_at=charts.iso(TIME + timedelta(minutes=30)))]
        result = charts.deduplicate(rows, TIME)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['longitude'], 70)

    def test_upper_time_location_and_below_ground_levels(self):
        target = TIME.replace(hour=0)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'soundings.nc'
            with Dataset(path, 'w') as dataset:
                dataset.createDimension('recNum', 3)
                dataset.createDimension('manLevel', 3)
                dataset.createDimension('nameLength', 4)
                for key, values in {
                    'synTime': [target.timestamp(), target.timestamp(), (target - timedelta(hours=12)).timestamp()],
                    'relTime': [(target + timedelta(hours=23)).timestamp(), (target - timedelta(minutes=45)).timestamp(), target.timestamp()],
                    'staLat': [20, 21, 22], 'staLon': [70, -9999, 72],
                    'wmoStaNum': [42001, 42002, 42003], 'numMand': [3, 3, 3],
                }.items():
                    dataset.createVariable(key, 'f8', ('recNum',))[:] = values
                for key, values in {
                    'prMan': [[1000, 850, 700], [800, 850, 700], [1000, 850, 700]],
                    'htMan': [[100, 1500, 3000]] * 3,
                    'tpMan': [[290, 280, 270]] * 3,
                    'wdMan': [[90, 100, 110]] * 3, 'wsMan': [[5, 10, 15]] * 3,
                }.items():
                    dataset.createVariable(key, 'f8', ('recNum', 'manLevel'))[:] = values
                names = dataset.createVariable('staName', 'S1', ('recNum', 'nameLength'))
                names[:] = np.array([[bytes([x]) for x in name] for name in (b'AAAA', b'BBBB', b'CCCC')], dtype='S1')
            rows = charts.decode_upper_nc(gzip.compress(path.read_bytes()), target, {42002: (21, 71, 2026)})
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(row['station'] != 'CCCC' for row in rows))
        self.assertFalse(any(row['station'] == 'BBBB' and row['level_hpa'] == 850 for row in rows))
        self.assertTrue(all(row['launch_at'] is None for row in rows if row['station'] == 'AAAA'))
        restored = next(row for row in rows if row['station'] == 'BBBB')
        self.assertEqual(restored['longitude'], 71)
        self.assertEqual(restored['location_source'], 'NOAA IGRA WMO station inventory')

    def test_observation_holes_do_not_receive_global_contours(self):
        rows = [{'latitude': lat, 'longitude': lon, 'mslp_hpa': p} for lat, lon, p in [(0, 0, 1000), (0, 4, 1012), (4, 0, 1016), (4, 4, 1020)]]
        result = charts.contours(rows, 'mslp_hpa', 4, 600)
        self.assertTrue(result['features'])
        for feature in result['features']:
            self.assertTrue(all(-6 < lon < 10 and -6 < lat < 10 for lon, lat in feature['geometry']['coordinates']))

    def test_qnh_reduction_prefers_reported_pressure_and_uses_temperature(self):
        rows = [dict(qnh_hpa=1013.25, elevation_m=0, temperature_c=20),
                dict(qnh_hpa=1013.25, elevation_m=1500, temperature_c=20),
                dict(qnh_hpa=1013.25, elevation_m=1500, temperature_c=-10),
                dict(qnh_hpa=1013.25, elevation_m=1500, temperature_c=20, mslp_hpa=1008),
                dict(qnh_hpa=1013.25, elevation_m=None, temperature_c=20)]
        charts.prepare_surface_pressure(rows)
        self.assertEqual(rows[0]['mslp_hpa'], 1013.25)
        self.assertLess(rows[1]['mslp_hpa'], 1013.25)
        self.assertGreater(rows[2]['mslp_hpa'], rows[1]['mslp_hpa'])
        self.assertEqual(rows[3]['mslp_hpa'], 1008)
        self.assertEqual(rows[3]['pressure_method'], 'reported')
        self.assertNotIn('mslp_hpa', rows[4])

    def test_smoothing_preserves_closure_and_open_endpoints(self):
        line = np.array([[0.,0.],[2.,0.],[2.,2.],[0.,2.],[0.,0.]])
        smooth = charts.smooth_line(line)
        np.testing.assert_array_equal(smooth[0], smooth[-1])
        self.assertGreater(len(smooth), len(line))
        self.assertTrue(np.all((smooth >= 0) & (smooth <= 2)))
        open_line = charts.smooth_line(line[:-1])
        np.testing.assert_array_equal(open_line[0], line[0])
        np.testing.assert_array_equal(open_line[-1], line[-2])

    def test_extended_ocean_analysis_and_temperature_bands(self):
        rows = [dict(latitude=lat, longitude=lon, temperature_c=value)
                for lat, lon, value in [(0,0,10),(0,4,12),(4,0,14),(4,4,16)]]
        analysed = charts.analysis_grid(rows, 'temperature_c', 1500)
        x, y, grid = analysed
        # Ocean-like unobserved area beyond the station convex hull is analysed,
        # but the opposite side of the planet must remain unsupported.
        self.assertFalse(grid.mask[np.argmin(abs(y-2)),np.argmin(abs(x-10))])
        self.assertTrue(grid.mask[np.argmin(abs(y-2)),np.argmin(abs(x-100))])
        bands = charts.temperature_shading(analysed, 1500)
        self.assertTrue(bands['features'])
        for feature in bands['features']:
            for ring in feature['geometry']['coordinates']:
                self.assertEqual(ring[0], ring[-1])
                self.assertGreaterEqual(len(ring), 4)

    def test_pressure_contours_and_colours_use_one_hpa_bands(self):
        rows = [dict(latitude=lat, longitude=lon, mslp_hpa=value)
                for lat, lon, value in [(0,0,1000),(0,4,1006),(4,0,1012),(4,4,1018)]]
        analysed = charts.analysis_grid(rows, 'mslp_hpa', 600)
        lines = charts.contours(rows, 'mslp_hpa', charts.PRESSURE_INTERVAL, 600, analysed)
        self.assertEqual(lines['properties']['interval'], 1)
        self.assertTrue(lines['features'])
        self.assertTrue(all(feature['properties']['value'] % 1 == 0 for feature in lines['features']))
        self.assertTrue(any(feature['properties']['value'] % 2 == 1 for feature in lines['features']))
        bands = charts.field_shading(analysed, 600, 'mslp_hpa')
        self.assertTrue(bands['features'])
        self.assertTrue(all(feature['properties']['high']-feature['properties']['low'] == 1 for feature in bands['features']))
        self.assertTrue(all(feature['properties']['value']==feature['properties']['low']+.5 for feature in bands['features']))

    def test_temperature_contours_and_colours_use_one_degree_bands(self):
        rows=[dict(latitude=lat,longitude=lon,temperature_c=value)
              for lat,lon,value in [(0,0,10),(0,4,16),(4,0,20),(4,4,26)]]
        analysed=charts.analysis_grid(rows,'temperature_c',600)
        lines=charts.contours(rows,'temperature_c',charts.TEMPERATURE_INTERVAL,600,analysed)
        self.assertEqual(lines['properties']['interval'],1)
        self.assertTrue(any(feature['properties']['value']%2==1 for feature in lines['features']))
        bands=charts.temperature_shading(analysed,600)
        self.assertEqual(bands['properties']['interval'],1)
        self.assertTrue(all(feature['properties']['high']-feature['properties']['low']==1 for feature in bands['features']))


if __name__ == '__main__':
    unittest.main()
