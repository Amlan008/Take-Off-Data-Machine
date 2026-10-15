"""Synthetic diagnostics checks; no upstream downloads or fabricated live data."""
import unittest
from datetime import datetime,timezone
import numpy as np
from synoptic_features import diagnose, wind_components, axis_mask


def fixture(fields, upper=False):
    x=np.arange(-10,10.1,.5); y=np.arange(5,25.1,.5)
    xx,yy=np.meshgrid(x,y); fields={key:value(xx,yy) for key,value in fields.items()}
    grids={key:(x,y,np.ma.array(value,mask=np.zeros(value.shape,bool))) for key,value in fields.items()}
    rows=[]
    for a in range(4,len(y)-4,3):
        for b in range(4,len(x)-4,3):
            row={'latitude':y[a],'longitude':x[b],'elevation_m':50,'observed_at':'2026-10-13T03:00:00Z'}
            row.update({key:float(value[a,b]) for key,value in fields.items()})
            if upper: row['level_hpa']=250
            rows.append(row)
    return rows,grids


class DiagnosticsTests(unittest.TestCase):
    def test_wind_from_direction_becomes_vector_without_direction_averaging(self):
        rows=[{'wind_kt':10,'wind_from_deg':0},{'wind_kt':10,'wind_from_deg':90},
              {'wind_kt':0,'wind_from_deg':None},{'wind_kt':10,'wind_from_deg':None}]
        wind_components(rows)
        self.assertAlmostEqual(rows[0]['u_ms'],0)
        self.assertLess(rows[0]['v_ms'],0)
        self.assertLess(rows[1]['u_ms'],0)
        self.assertAlmostEqual(rows[1]['v_ms'],0)
        self.assertEqual(rows[2]['u_ms'],0)
        self.assertIsNone(rows[3]['u_ms'])

    def test_supported_pressure_low_and_uncertain_cyclone(self):
        rows,grids=fixture({'mslp_hpa':lambda x,y:1000+.25*(x*x+(y-15)**2),
                           'u_ms':lambda x,y:-3*(y-15),'v_ms':lambda x,y:3*x})
        result=diagnose(rows,grids,'surface')
        types=[f['properties']['feature_type'] for f in result['features']]
        self.assertIn('low',types)
        self.assertIn('cyclone',types)
        self.assertNotIn('tropical',types)
        self.assertNotIn('front',types)
        self.assertTrue(result['properties']['status'].startswith('No dew'))

    def test_sparse_and_elevated_pressure_reports_do_not_create_features(self):
        rows,grids=fixture({'mslp_hpa':lambda x,y:1000+.25*(x*x+(y-15)**2)})
        self.assertFalse(diagnose(rows[:3],grids,'surface')['features'])
        for row in rows: row['elevation_m']=2000
        self.assertFalse(diagnose(rows,grids,'surface')['features'])

    def test_temperature_only_gradient_is_not_a_front(self):
        rows,grids=fixture({'mslp_hpa':lambda x,y:1000+x*x,'temperature_c':lambda x,y:15+10*np.tanh(x),
                           'u_ms':lambda x,y:-8*np.tanh(x),'v_ms':lambda x,y:6*np.tanh(x)})
        self.assertFalse(any(f['properties']['feature_type']=='front' for f in diagnose(rows,grids,'surface')['features']))

    def test_multiple_supported_front_indicators_produce_candidate_boundary(self):
        rows,grids=fixture({'mslp_hpa':lambda x,y:1000+1.5*x*x,'temperature_c':lambda x,y:15+10*np.tanh(x),
                           'dewpoint_c':lambda x,y:5+8*np.tanh(x),
                           'theta_k':lambda x,y:290+10*np.tanh(x),'theta_e_k':lambda x,y:310+20*np.tanh(x),
                           'u_ms':lambda x,y:-8*np.tanh(x),'v_ms':lambda x,y:6*np.tanh(x)})
        result=diagnose(rows,grids,'surface')
        fronts=[f for f in result['features'] if f['properties']['feature_type']=='front']
        self.assertTrue(fronts)
        self.assertTrue(all(f['properties']['label']=='Potential frontal boundary' for f in fronts))

    def test_coherent_upper_jet_and_speed_threshold(self):
        rows,grids=fixture({'height_m':lambda x,y:10500+20*(y-15),
                           'u_ms':lambda x,y:20+35*np.exp(-((y-15)/2)**2),'v_ms':lambda x,y:x*0},True)
        result=diagnose(rows,grids,'upper',250)
        jets=[f for f in result['features'] if f['properties']['feature_type']=='jet']
        self.assertTrue(jets)
        self.assertTrue(all(f['properties']['maximum_wind_kt']>=60 for f in jets))
        self.assertTrue(all(f['properties']['wind_to_deg']==90 for f in jets))
        self.assertFalse(any(f['properties']['feature_type']=='jet' for f in diagnose(rows,grids,'upper',700)['features']))

    def test_strong_flow_crossing_speed_ribbon_is_not_a_jet_axis(self):
        rows,grids=fixture({'height_m':lambda x,y:10500+20*(y-15),
                           'u_ms':lambda x,y:x*0,'v_ms':lambda x,y:20+35*np.exp(-((y-15)/2)**2)},True)
        self.assertFalse(any(f['properties']['feature_type']=='jet' for f in diagnose(rows,grids,'upper',250)['features']))

    def test_thermal_moisture_gradients_without_wind_support_are_not_fronts(self):
        rows,grids=fixture({'mslp_hpa':lambda x,y:1000+1.5*x*x,'temperature_c':lambda x,y:15+10*np.tanh(x),
                           'dewpoint_c':lambda x,y:5+8*np.tanh(x),'u_ms':lambda x,y:x*0,'v_ms':lambda x,y:y*0})
        self.assertFalse(any(f['properties']['feature_type']=='front' for f in diagnose(rows,grids,'surface')['features']))

    def test_upper_height_trough_and_ridge_axes(self):
        for sign,type_ in ((1,'trough'),(-1,'ridge')):
            rows,grids=fixture({'height_m':lambda x,y:5500+sign*2*x*x},True)
            self.assertTrue(any(f['properties']['feature_type']==type_ for f in diagnose(rows,grids,'upper',500)['features']))

    def test_warm_core_candidate_requires_vertical_evidence_and_freshness(self):
        rows,grids=fixture({'mslp_hpa':lambda x,y:1000+.25*(x*x+(y-15)**2),
                           'u_ms':lambda x,y:-3*(y-15),'v_ms':lambda x,y:3*x})
        soundings=[]
        for level,temp in ((850,20),(500,-10),(200,-50)):
            for lat,lon in ((15,0),(15,.2),(15,-.2)):
                soundings.append(dict(latitude=lat,longitude=lon,level_hpa=level,temperature_c=temp,observed_at='2026-10-13T00:00:00Z'))
            for lat,lon in ((22,0),(8,0),(15,7),(15,-7),(21,4),(9,-4)):
                soundings.append(dict(latitude=lat,longitude=lon,level_hpa=level,temperature_c=temp-3,observed_at='2026-10-13T00:00:00Z'))
        result=diagnose(rows,grids,'surface',upper_rows=soundings)
        warm=[f for f in result['features'] if f['properties']['feature_type']=='warm_core']
        self.assertTrue(warm)
        self.assertEqual(warm[0]['properties']['tropical_status'],'not_established')
        self.assertEqual(warm[0]['properties']['gray_factors']['ocean_heat']['state'],'unavailable')
        for row in soundings: row['observed_at']='2026-10-12T00:00:00Z'
        self.assertFalse(any(f['properties']['feature_type'] in ('tropical','warm_core') for f in diagnose(rows,grids,'surface',upper_rows=soundings)['features']))


if __name__=='__main__': unittest.main()
