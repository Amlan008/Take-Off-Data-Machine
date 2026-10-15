"""Physical and negative-case regressions; not an operational skill validation."""
import json
import unittest
import numpy as np
from airmass_regions import thermodynamics,prepare_thermodynamics,region_polygons,air_mass_regions
from cyclone_environment import assess_cyclone
from synoptic_features import diagnose
from test_synoptic_features import fixture


class RegionTests(unittest.TestCase):
    def test_theta_and_moisture_physical_limits(self):
        values=thermodynamics(20,10,1000)
        self.assertAlmostEqual(values['theta_k'],293.15)
        self.assertGreater(values['theta_e_k'],values['theta_k'])
        self.assertTrue(5 < values['mixing_ratio_gkg'] < 10)
        self.assertIsNone(thermodynamics(0,10,1000))
        self.assertIsNone(thermodynamics(None,0,1000))

    def test_qnh_is_not_used_as_station_pressure(self):
        rows=[dict(temperature_c=20,dewpoint_c=10,mslp_hpa=1010,elevation_m=700),
              dict(temperature_c=20,dewpoint_c=10,mslp_hpa=1010),
              dict(temperature_c=20,dewpoint_c=10,mslp_hpa=1010,elevation_m=2000)]
        prepare_thermodynamics(rows)
        self.assertGreater(rows[0]['theta_k'],293.15)
        self.assertIn('approximate',rows[0]['thermodynamic_pressure_method'])
        self.assertIsNone(rows[1]['theta_k']);self.assertIsNone(rows[2]['theta_k'])

    def test_polygons_preserve_holes_and_drop_small_islands(self):
        x=np.arange(30.);y=np.arange(30.);mask=np.zeros((30,30),bool)
        mask[2:25,2:25]=True;mask[9:16,9:16]=False;mask[27:29,27:29]=True
        result=region_polygons(mask,x,y,{'feature_type':'airmass_region','evidence':[]})
        self.assertTrue(result)
        self.assertTrue(any(len(f['geometry']['coordinates'])>=2 for f in result))
        self.assertTrue(all(max(pt[0] for ring in f['geometry']['coordinates'] for pt in ring)<26 for f in result))
        json.dumps(result,allow_nan=False)

    def test_regions_need_real_common_thermodynamic_support(self):
        rows,grids=fixture({'theta_k':lambda x,y:305+x*.1,'theta_e_k':lambda x,y:320+x*.1,'mixing_ratio_gkg':lambda x,y:np.full_like(x,8)})
        result=air_mass_regions(rows,grids,'2026-10-15T00:00:00Z')
        self.assertTrue(result)
        self.assertTrue(all(f['properties']['moisture_class']=='moist' for f in result))
        self.assertFalse(air_mass_regions(rows[:3],grids,'2026-10-15T00:00:00Z'))

    def test_cold_moist_region_has_moisture_label_independent_of_temperature(self):
        rows,grids=fixture({'theta_k':lambda x,y:np.full_like(x,280),'theta_e_k':lambda x,y:np.full_like(x,300),'mixing_ratio_gkg':lambda x,y:np.full_like(x,8)})
        result=air_mass_regions(rows,grids,'2026-10-15T00:00:00Z')
        self.assertTrue(result);self.assertTrue(all(f['properties']['thermal_class']=='cold' and f['properties']['moisture_class']=='moist' for f in result))

    def test_gray_missing_factors_are_not_satisfied_and_no_tropical_type(self):
        for latitude in (-55,0,15,55):
            result=assess_cyclone([0,latitude],[],'2026-10-15T00:00:00Z',False,1e-5)
            self.assertEqual(result['feature_type'],'cyclone')
            self.assertEqual(result['tropical_status'],'not_established')
            self.assertEqual(result['gray_factors']['ocean_heat']['state'],'unavailable')
            self.assertEqual(result['gray_factors']['organized_convection']['state'],'unavailable')
            self.assertEqual(result['latitude_caution'],abs(latitude)>40)
        json.dumps(assess_cyclone([np.float64(0),np.float64(55)],[],
            '2026-10-15T00:00:00Z',False,np.float64(1e-5)),allow_nan=False)

    def test_environmental_latitude_gradient_is_not_a_warm_core(self):
        rows=[]
        for level in (850,500,200):
            for lat,lon in ((55,0),(55,.2),(55,-.2),(62,0),(48,0),(55,7),(55,-7),(61,4),(49,-4)):
                rows.append(dict(latitude=lat,longitude=lon,level_hpa=level,temperature_c=20-(lat-55),observed_at='2026-10-15T00:00:00Z'))
        result=assess_cyclone([0,55],rows,'2026-10-15T00:00:00Z',False,1e-5)
        self.assertEqual(result['feature_type'],'cyclone')
        self.assertTrue(all(abs(v['anomaly_c'])<.01 for v in result['thermal_structure']))

    def test_stale_sounding_not_used_in_gray_shear(self):
        rows=[]
        for level in (850,200):
            for lat,lon in ((15,0),(15,1),(16,0)):
                rows.append(dict(latitude=lat,longitude=lon,level_hpa=level,wind_kt=10,wind_from_deg=90,observed_at='2026-10-15T00:00:00Z'))
        self.assertEqual(assess_cyclone([0,15],rows,'2026-10-15T03:00:00Z',False)['gray_factors']['deep_layer_shear']['state'],'favourable')
        self.assertEqual(assess_cyclone([0,15],rows,'2026-10-16T03:00:00Z',False)['gray_factors']['deep_layer_shear']['state'],'unavailable')

    def test_no_ridge_from_pressure_geometry_without_flow(self):
        rows,grids=fixture({'mslp_hpa':lambda x,y:1020-2*x*x})
        self.assertFalse(any(f['properties']['feature_type']=='ridge' for f in diagnose(rows,grids,'surface')['features']))

    def test_front_does_not_require_deep_trough_but_does_require_wind_shift(self):
        fields={'mslp_hpa':lambda x,y:np.full_like(x,1010),'theta_k':lambda x,y:290+10*np.tanh(x),
                'theta_e_k':lambda x,y:310+20*np.tanh(x),'temperature_c':lambda x,y:15+10*np.tanh(x),
                'dewpoint_c':lambda x,y:5+8*np.tanh(x),'u_ms':lambda x,y:-8*np.tanh(x),'v_ms':lambda x,y:6*np.tanh(x)}
        rows,grids=fixture(fields)
        self.assertTrue(any(f['properties']['feature_type']=='front' for f in diagnose(rows,grids,'surface')['features']))
        fields['u_ms']=lambda x,y:np.full_like(x,8);fields['v_ms']=lambda x,y:np.zeros_like(x)
        rows,grids=fixture(fields)
        self.assertFalse(any(f['properties']['feature_type']=='front' for f in diagnose(rows,grids,'surface')['features']))


if __name__=='__main__':unittest.main()
