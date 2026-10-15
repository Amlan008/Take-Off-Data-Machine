"""Decoder and analysis checks for observation charts; no network required."""
import gzip
import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import json
import os
import subprocess
import textwrap

import eccodes as ec
import numpy as np
from netCDF4 import Dataset

spec = importlib.util.spec_from_file_location('charts', Path(__file__).with_name('build_observation_charts.py'))
charts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(charts)
TIME = datetime(2026, 10, 13, 3, tzinfo=timezone.utc)


def workflow_script(step_name):
    source = (Path(__file__).resolve().parents[1] / '.github/workflows/gfs-hazards.yml').read_text()
    section = source.split('      - name: ' + step_name + '\n', 1)[1].split('      - name:', 1)[0]
    return textwrap.dedent(section.split('        run: |\n', 1)[1])


def simulate_workflow_script(script, state, env_overrides=None):
    """Run the actual workflow Bash with isolated fake Python/Git/sleep tools."""
    with tempfile.TemporaryDirectory() as directory:
        folder = Path(directory)
        bin_folder = folder / 'bin'
        bin_folder.mkdir()
        state_file = folder / 'state.json'
        state_file.write_text(json.dumps(state))
        fake = '''#!/usr/bin/env python3
import json,sys
from pathlib import Path
p=Path('state.json'); d=json.loads(p.read_text()); name=Path(sys.argv[0]).name; args=sys.argv[1:]; code=0
if name=='python':
    if args and args[0]=='scripts/build_observation_charts.py':
        d.setdefault('build_args',[]).append(args[1:])
        index=d.get('build_calls',0); d['build_calls']=index+1
        attempt=d['builds'][index]; d['ready']=attempt['ready']; code=attempt['exit']
    else: code=0 if d.get('ready') else 1
elif name=='git':
    d.setdefault('git_calls',[]).append(args)
    if args[0]=='diff': code=1 if d.get('changed',True) else 0
    elif args[0]=='push':
        index=d.get('push_calls',0); d['push_calls']=index+1; code=d['pushes'][index]
    elif args[0]=='pull': code=d.get('pull_exit',0)
else: d['sleep_calls']=d.get('sleep_calls',0)+1
p.write_text(json.dumps(d)); sys.exit(code)
'''
        for name in ('python', 'git', 'sleep'):
            executable = bin_folder / name
            executable.write_text(fake)
            executable.chmod(0o755)
        env = dict(os.environ, PATH=str(bin_folder) + os.pathsep + os.environ['PATH'], CHART_BRANCH='main')
        env.update(env_overrides or {})
        result = subprocess.run(['bash', '-e', '-o', 'pipefail'], input=script, text=True,
                                cwd=folder, env=env, capture_output=True)
        return result, json.loads(state_file.read_text())


class ObservationTests(unittest.TestCase):
    def test_workflow_passes_surface_only_and_rejects_non_synoptic_input(self):
        script=workflow_script('Build surface, upper-air and synoptic diagnostics')
        for hour in range(0,24,3):
            value=f'2026-10-15T{hour:02d}:00'
            result,state=simulate_workflow_script(script,{'builds':[{'exit':0,'ready':True}]},{'OBSERVATION_TIME':value})
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(state['build_args'],[['--surface-time',value]])
        result,state=simulate_workflow_script(script,{'builds':[]},{'OBSERVATION_TIME':'2026-10-15T02:00'})
        self.assertNotEqual(result.returncode,0)
        self.assertNotIn('build_calls',state)

    def test_workflow_retry_preserves_partial_success(self):
        script = workflow_script('Build surface, upper-air and synoptic diagnostics')
        complete, partial, failed = {'exit':0,'ready':True}, {'exit':0,'ready':False}, {'exit':1,'ready':False}
        for attempts, expected in (([complete],0),([failed,complete],0),([partial,complete],0),
                                   ([partial,partial],0),([partial,failed],0),([failed,failed],1)):
            result, state = simulate_workflow_script(script, {'builds':attempts})
            self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
            self.assertEqual(state['build_calls'],len(attempts))
            self.assertEqual(state.get('sleep_calls',0), len(attempts)-1)

    def test_workflow_push_retry_is_non_destructive(self):
        script = workflow_script('Commit generated observation charts')
        for pushes, pull_exit, expected in (([0],0,0),([1,0],0,0),([1,1,1],0,1),([1],1,1)):
            result, state = simulate_workflow_script(script, {'pushes':pushes,'pull_exit':pull_exit})
            self.assertEqual(result.returncode,expected,result.stdout + result.stderr)
            self.assertEqual(state['push_calls'],len(pushes))
            self.assertFalse(any('--force' in arg or arg=='-f' for call in state['git_calls'] for arg in call))
            for call in state['git_calls']:
                if call[0]=='pull': self.assertEqual(call,['pull','--rebase','origin','main'])
        result, state = simulate_workflow_script(script, {'changed':False,'pushes':[]})
        self.assertEqual(result.returncode,0)
        self.assertNotIn('push_calls',state)

    def test_half_past_triggers_select_current_three_hourly_cycle(self):
        self.assertEqual(charts.CHART_DELAY_MINUTES, 30)
        for hour in range(0, 24, 3):
            start = TIME.replace(hour=hour, minute=30)
            surface, upper = charts.resolve_cycles(start)
            self.assertEqual(surface, start.replace(minute=0))
            self.assertEqual(upper, start.replace(hour=hour // 12 * 12, minute=0))
        before = TIME.replace(hour=0, minute=29)
        surface, upper = charts.resolve_cycles(before)
        self.assertEqual(surface, (before - timedelta(days=1)).replace(hour=21, minute=0))
        self.assertEqual(upper, (before - timedelta(days=1)).replace(hour=12, minute=0))

    def test_explicit_surface_dispatch_does_not_shift_with_delayed_start(self):
        now = TIME.replace(day=15, hour=13)
        surface, upper = charts.resolve_cycles(now, '2026-10-14T21:00')
        self.assertEqual(charts.iso(surface), '2026-10-14T21:00:00Z')
        self.assertEqual(charts.iso(upper), '2026-10-14T12:00:00Z')
        for hour in range(0,24,3):
            surface, upper = charts.resolve_cycles(now, f'2026-10-14T{hour:02d}:00')
            self.assertEqual(surface.hour, hour)
            self.assertEqual(upper.hour, hour//12*12)
        with self.assertRaises(ValueError): charts.resolve_cycles(now, '2026-10-14T02:00')
        with self.assertRaises(ValueError): charts.resolve_cycles(now, '2026-10-14T06:00', '2026-10-14T06:00')
        with self.assertRaises(ValueError): charts.resolve_cycles(now, '2026-10-32T06:00')

    def test_new_nominal_sounding_cycle_is_attempted_at_half_past(self):
        for hour in (0, 12):
            start = TIME.replace(hour=hour, minute=30)
            self.assertEqual(charts.slot(start, 12, charts.CHART_DELAY_MINUTES), start.replace(minute=0))
        before = TIME.replace(hour=12, minute=29)
        self.assertEqual(charts.slot(before, 12, charts.CHART_DELAY_MINUTES), before.replace(hour=0, minute=0))

    def test_early_build_does_not_download_future_hourly_files(self):
        errors = []
        with patch.object(charts, 'fetch', return_value=b'fixture') as fetch:
            result = charts.retrieve(TIME, 'metar', lambda payload, target: [payload], errors,
                                     now=TIME + timedelta(minutes=15))
        self.assertEqual(len(result), 2)
        self.assertEqual(fetch.call_count, 2)
        self.assertTrue(any('later hourly file not yet due' in error for error in errors))
        self.assertFalse(any('04' in call.args[0].rsplit('/', 1)[-1].split('_')[1][:2] for call in fetch.call_args_list))

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
                    'tdMan': [[3, 5, 10]] * 3,
                    'wdMan': [[90, 100, 110]] * 3, 'wsMan': [[5, 10, 15]] * 3,
                }.items():
                    dataset.createVariable(key, 'f8', ('recNum', 'manLevel'))[:] = values
                names = dataset.createVariable('staName', 'S1', ('recNum', 'nameLength'))
                names[:] = np.array([[bytes([x]) for x in name] for name in (b'AAAA', b'BBBB', b'CCCC')], dtype='S1')
            rows = charts.decode_upper_nc(gzip.compress(path.read_bytes()), target, {42002: (21, 71, 2026)})
        self.assertEqual(len(rows), 4)
        moist = next(row for row in rows if row['station'] == 'AAAA' and row['level_hpa'] == 850)
        self.assertAlmostEqual(moist['dewpoint_c'], 1.85)
        self.assertAlmostEqual(moist['temperature_c'], 6.85)
        self.assertGreater(moist['relative_humidity_pct'], 0)
        self.assertLess(moist['relative_humidity_pct'], 100)
        self.assertTrue(all(row['station'] != 'CCCC' for row in rows))
        self.assertFalse(any(row['station'] == 'BBBB' and row['level_hpa'] == 850 for row in rows))
        self.assertTrue(all(row['launch_at'] is None for row in rows if row['station'] == 'AAAA'))
        restored = next(row for row in rows if row['station'] == 'BBBB')
        self.assertEqual(restored['longitude'], 71)
        self.assertEqual(restored['location_source'], 'NOAA IGRA WMO station inventory')

    def test_pressure_level_interpolation_and_no_extrapolation(self):
        base = {'station': 'TEST', 'latitude': 20, 'longitude': 70,
                'observed_at': charts.iso(TIME), 'source': 'NOAA MADIS radiosonde'}
        rows = [dict(base, level_hpa=850, temperature_c=10, dewpoint_c=5, height_m=1500, wind_kt=20, wind_from_deg=350),
                dict(base, level_hpa=700, temperature_c=0, dewpoint_c=-5, height_m=3000, wind_kt=20, wind_from_deg=10)]
        result = charts.pressure_samples(rows)
        self.assertEqual({row['level_hpa'] for row in result}, {850, 800, 700})
        middle = next(row for row in result if row['level_hpa'] == 800)
        self.assertEqual(middle['level_method'], 'interpolated_log_pressure')
        self.assertTrue(0 < middle['temperature_c'] < 10)
        self.assertTrue(middle['wind_from_deg'] < 20 or middle['wind_from_deg'] > 340)
        self.assertTrue(0 < middle['relative_humidity_pct'] <= 100)
        self.assertIsNone(charts.relative_humidity(0, 10))

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
