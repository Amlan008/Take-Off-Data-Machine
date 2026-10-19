"""Offline provider, provenance and late-arrival regression tests."""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import wyoming_upper_air as w

TIME = datetime(2026,10,19,tzinfo=timezone.utc)
STATION = {'stationid':'94326','wmo_station':'94326','latitude':-23.795,'longitude':133.889,'src':'BUFR'}
HEADER = 'time,longitude,latitude,pressure_hPa,geopotential height_m,temperature_C,dew point temperature_C,wind direction_degree,wind speed_m/s\n'
CSV = (HEADER + '\n'.join(f'2026-10-18 22:{24+i:02}:56,133.889,-23.795,{p},{h},{t},{td},90,10'
       for i,(p,h,t,td) in enumerate([(950,550,26,9),(925,800,24,6),(850,1500,20,5),(700,3000,10,0)]))).encode()


def row(p=850, source='NOAA MADIS radiosonde', **kw):
    return dict(station='ALICE',wmo_station='94326',latitude=-23.795,longitude=133.889,
                observed_at=w.stamp(TIME),level_hpa=p,source=source,
                temperature_c=20,dewpoint_c=None,height_m=1500,wind_kt=10,wind_from_deg=90,**kw)


class WyomingTests(unittest.TestCase):
    def test_current_csv_units_launch_nominal_and_site_not_balloon_drift(self):
        data=w.decode_csv(CSV,TIME,STATION)
        self.assertEqual(len(data),4)
        self.assertAlmostEqual(data[0]['wind_kt'],19.438,places=3)
        self.assertEqual(data[0]['observed_at'],w.stamp(TIME))
        self.assertEqual(data[0]['launch_at'],'2026-10-18T22:24:56Z')
        self.assertEqual(data[0]['latitude'],STATION['latitude'])
        self.assertEqual(data[0]['level_method'],'observed')

    def test_wrong_units_stale_launch_and_error_pages_rejected(self):
        for payload in (CSV.replace(b'wind speed_m/s',b'wind speed_knots'), b'<html>No data</html>',
                        CSV.replace(b'2026-10-18',b'2026-10-17')):
            with self.assertRaises(ValueError):
                w.decode_csv(payload,TIME,STATION)

    def test_inventory_exact_cycle_and_unique_station(self):
        s=dict(stationid='94326',lat=-23.795,lon=133.889,src='FM35')
        payload=json.dumps({'datetime':'2026-10-19 00:00:00','stations':[s,dict(s,src='BUFR'),dict(s,stationid='bad')]}).encode()
        data=w.inventory(payload,TIME)
        self.assertEqual(len(data),1)
        self.assertEqual(data[0]['src'],'BUFR')
        with self.assertRaises(ValueError):
            w.inventory(payload,TIME+timedelta(hours=12))

    def test_merge_primary_wins_and_supplement_labels(self):
        primary=[row()]
        other=row(source=w.SOURCE)
        other.update(station='94326',dewpoint_c=5,temperature_c=21,wind_kt=25)
        merged=w.merge_profiles(primary,[other],TIME)
        self.assertEqual(len(merged),1)
        self.assertEqual(merged[0]['temperature_c'],20)
        self.assertEqual(merged[0]['wind_kt'],10)
        self.assertEqual(merged[0]['dewpoint_c'],5)
        self.assertEqual(merged[0]['field_sources']['dewpoint_c'],w.SOURCE)
        self.assertIsNone(primary[0]['dewpoint_c'])

    def test_missing_levels_one_canonical_profile(self):
        other=row(700,source=w.SOURCE)
        other.update(station='94326',latitude=-23.796)
        merged=w.merge_profiles([row()],[other],TIME)
        self.assertEqual(len(w.profiles(merged)),1)
        self.assertEqual(len(merged),2)
        self.assertEqual(merged[-1]['source'],w.SOURCE)

    def test_different_cycles_or_known_launches_never_spliced(self):
        primary=row(launch_at='2026-10-18T23:00:00Z')
        other=row(700,source=w.SOURCE,launch_at='2026-10-18T22:00:00Z')
        self.assertEqual(len(w.merge_profiles([primary],[other],TIME)),1)
        other['observed_at']='2026-10-18T12:00:00Z'
        self.assertEqual(len(w.merge_profiles([primary],[other],TIME)),1)

    def test_inconsistent_temperature_does_not_fill_dewpoint(self):
        other=row(source=w.SOURCE)
        other.update(temperature_c=35,dewpoint_c=30)
        merged=w.merge_profiles([row()],[other],TIME)
        self.assertIsNone(merged[0]['dewpoint_c'])

    def test_thinning_keeps_exact_levels_no_averages(self):
        payload=(HEADER+'\n'.join(f'2026-10-18 23:00:00,0,0,{p},1000,10,5,90,2'
                                 for p in (951,950.9,950.8,950,949,925,900,850))).encode()
        data=w.decode_csv(payload,TIME,STATION)
        self.assertIn(925,[r['level_hpa'] for r in data])
        self.assertNotIn(950.9,[r['level_hpa'] for r in data])
        self.assertEqual(data[0]['temperature_c'],10)

    def test_serial_request_budget_and_throttling(self):
        calls=[]
        client=w.WyomingClient(max_requests=1,request=lambda u:calls.append(u) or b'ok',pause=lambda _:None)
        self.assertEqual(client.get('test'),b'ok')
        with self.assertRaises(RuntimeError): client.get('test')
        self.assertEqual(len(calls),1)
        def limited(url): raise HTTPError(url,429,'rate limited',{},None)
        client=w.WyomingClient(request=limited)
        with self.assertRaises(HTTPError): client.get('https://weather.uwyo.edu')
        self.assertTrue(client.stopped)
        with self.assertRaises(RuntimeError): client.get('test')

    def test_gap_budget_rotation_and_no_live_network(self):
        stations=[dict(stationid=s,lat=-23.795,lon=133.889,src='BUFR') for s in ('94326','94327')]
        inventory=json.dumps({'datetime':'2026-10-19 00:00:00','stations':stations}).encode()
        calls=[]
        def request(url):
            calls.append(url)
            return inventory if 'sounding_json' in url else CSV
        ledger,errors={},[]
        client=w.WyomingClient(request=request,pause=lambda _:None)
        rows,stats=client.fill(TIME,[],ledger,errors,TIME,max_profiles=1)
        self.assertEqual(stats['attempted'],1)
        self.assertEqual(stats['deferred'],1)
        self.assertIn('94326',ledger)
        client=w.WyomingClient(request=request,pause=lambda _:None)
        client.fill(TIME,[],ledger,[],TIME+timedelta(hours=3),max_profiles=1)
        self.assertIn('id=94327',calls[-1])

    def test_refresh_retains_old_success_when_feeds_fail(self):
        import build_observation_charts as b
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            directory=root/'upper'/'2026101900'
            directory.mkdir(parents=True)
            original=row()
            (directory/'soundings.json').write_text(json.dumps({'valid_time':w.stamp(TIME),'profiles':[{'levels':[original]}]}))
            class Failed:
                def fill(self,target,rows,ledger,errors,now,**kw):
                    errors.append('Wyoming unavailable')
                    return rows,{'attempted':0}
            with patch.object(b,'retrieve',return_value=[]):
                rows,errors,stats=b.refresh_upper(root,TIME,{},Failed(),{},TIME+timedelta(hours=3))
            self.assertEqual(rows[0]['temperature_c'],20)
            self.assertEqual(stats['fresh_madis_rows'],0)
            self.assertIn('Wyoming unavailable',errors)

    def test_every_surface_cycle_maps_to_latest_nominal_upper(self):
        import build_observation_charts as b
        for hour in range(0,24,3):
            now=TIME+timedelta(hours=hour,minutes=30)
            surface,upper=b.resolve_cycles(now,None,None)
            self.assertEqual(surface.hour,hour)
            self.assertEqual(upper.hour,0 if hour<12 else 12)
            self.assertEqual((upper-timedelta(hours=12)).hour,12 if hour<12 else 0)

    def test_late_madis_receipt_hours_are_rechecked_and_bounded(self):
        import build_observation_charts as b
        for age, expected in ((3,5),(9,11),(24,14)):
            with patch.object(b,'fetch',return_value=b'profile') as fetch:
                rows=b.retrieve(TIME,'raob',lambda payload,target:[{'cycle':target}],[],now=TIME+timedelta(hours=age))
            self.assertEqual(len(rows),expected)
            self.assertTrue(any('20261019_0200.gz' in call.args[0] for call in fetch.call_args_list))
            self.assertEqual(fetch.call_args_list[0].kwargs,{'attempts':1,'timeout':15})

    def test_exact_chart_level_can_fill_missing_field_without_overwrite(self):
        import build_observation_charts as b
        middle=row()
        below=row(800); below['dewpoint_c']=0
        above=row(900); above['dewpoint_c']=10
        sampled=b.pressure_samples([below,middle,above])
        sample=next(r for r in sampled if r['level_hpa']==850)
        self.assertEqual(sample['temperature_c'],20)
        self.assertGreater(sample['dewpoint_c'],0)
        self.assertLess(sample['dewpoint_c'],10)
        self.assertEqual(sample['level_method'],'observed_with_interpolated_fields')
        self.assertIn('dewpoint_c',sample['interpolated_fields'])

    def test_observed_partial_wind_is_retained_not_spliced(self):
        import build_observation_charts as b
        middle=row(); middle['wind_from_deg']=None
        result=b.pressure_samples([row(800),middle,row(900)])
        sample=next(r for r in result if r['level_hpa']==850)
        self.assertEqual(sample['wind_kt'],10)
        self.assertIsNone(sample['wind_from_deg'])

    def test_wyoming_humidity_is_derived_and_bad_dewpoint_rejected(self):
        data=w.decode_csv(CSV,TIME,STATION)
        self.assertGreater(data[0]['relative_humidity_pct'],0)
        self.assertLessEqual(data[0]['relative_humidity_pct'],100)
        invalid=CSV.replace(b',26,9,',b',26,40,')
        self.assertIsNone(w.decode_csv(invalid,TIME,STATION)[0]['dewpoint_c'])


if __name__=='__main__': unittest.main()
