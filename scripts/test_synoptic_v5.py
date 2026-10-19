"""Challenger mechanics and negative cases, not meteorological skill validation."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from datetime import datetime
import numpy as np
from test_synoptic_features import fixture
from synoptic_features import diagnose
from synoptic_v5 import VERSION,evidence_score,enclosure,diagnose_v5,apply_policy


class V5Tests(unittest.TestCase):
    def test_weights_bounded_missing_not_renormalized(self):
        result=evidence_score('front',{'thermal_structure':1})
        self.assertEqual(result['support_index'],40);self.assertEqual(result['assessed_weight'],40)
        self.assertEqual(result['evidence_groups']['weather']['state'],'unknown')
        self.assertIsNone(result['probability'])
        with self.assertRaises(ValueError):evidence_score('front',{'weather':2})

    def test_pressure_enclosure_and_high_reverse(self):
        x=np.arange(-10,11,.5);y=np.arange(5,26,.5);xx,yy=np.meshgrid(x,y)
        z=1000+.15*(xx*xx+(yy-15)**2);valid=np.ones(z.shape,bool)
        low=enclosure(z,valid,x,y,[0,15]);high=enclosure(-z,valid,x,y,[0,15],high=True)
        self.assertEqual(low['closure_status'],'supported_enclosure');self.assertEqual(low,high)
        self.assertGreater(low['enclosure_depth_lower_bound_hpa'],1)
        # A missing-data channel to the minimum must not invent an enclosing wall.
        valid[len(y)//2:,len(x)//2]=False
        self.assertEqual(enclosure(z,valid,x,y,[0,15])['closure_status'],'unresolved')

    def test_slope_open_extremum_no_closed_low(self):
        x=np.arange(-10,11,.5);y=np.arange(5,26,.5);xx,yy=np.meshgrid(x,y)
        self.assertEqual(enclosure(1000+xx,np.ones(xx.shape,bool),x,y,[0,15])['closure_status'],'unresolved')

    def test_unsupported_edge_is_not_global_prominence(self):
        x=np.arange(-3,3.1,.5);y=np.arange(12,18.1,.5);xx,yy=np.meshgrid(x,y)
        z=1000+.1*(xx*xx+(yy-15)**2)
        result=enclosure(z,np.ones(z.shape,bool),x,y,[0,15])
        self.assertEqual(result['closure_status'],'unresolved')

    def test_closed_low_no_tropical_intensity_from_weather(self):
        rows,grids=fixture({'mslp_hpa':lambda x,y:995+.25*(x*x+(y-15)**2),
                           'u_ms':lambda x,y:-3*(y-15),'v_ms':lambda x,y:3*x})
        for row in rows:row.update(weather='TS +RA',cloud_type='CB',visibility_m=10000)
        before=copy.deepcopy(rows)
        result=diagnose_v5(rows,grids,'2026-10-19T03:00:00Z')
        self.assertEqual(rows,before)
        types={f['properties']['feature_type'] for f in result['features']}
        self.assertIn('low',types);self.assertIn('cyclone',types)
        self.assertFalse(types&{'tropical','extratropical','monsoon_low'})
        for f in result['features']:
            if f['properties']['feature_type']=='cyclone':self.assertEqual(f['properties']['tropical_status'],'not_established')
        json.dumps(result,allow_nan=False)

    def test_front_missing_dewpoint_remains_eligible_no_v4_lineage(self):
        rows,grids=fixture({'theta_k':lambda x,y:290+10*np.tanh(x),
            'temperature_c':lambda x,y:15+10*np.tanh(x),'u_ms':lambda x,y:-8*np.tanh(x),'v_ms':lambda x,y:6*np.tanh(x)})
        old=diagnose(rows,grids,'surface');old['properties']['algorithm']='v4'
        result=diagnose_v5(rows,grids,'2026-10-19T03:00:00Z',old,rows,grids,'2026-10-19T00:00:00Z')
        fronts=[f for f in result['features'] if f['properties']['feature_type']=='front']
        self.assertTrue(fronts)
        for front in fronts:
            p=front['properties'];self.assertEqual(p['front_type'],'unclassified')
            self.assertTrue(p['feature_id'].startswith('v5:'));self.assertEqual(p['evidence_groups']['weather']['points'],0)

    def test_weather_wind_shift_no_thermal_front(self):
        rows,grids=fixture({'temperature_c':lambda x,y:np.full_like(x,20),
            'theta_k':lambda x,y:np.full_like(x,293),'u_ms':lambda x,y:-8*np.tanh(x),'v_ms':lambda x,y:6*np.tanh(x)})
        for row in rows:row.update(weather='TS',pressure_change_hpa_3h=4)
        self.assertFalse(any(f['properties']['feature_type']=='front' for f in diagnose_v5(rows,grids,'2026-10-19T03:00:00Z')['features']))

    def test_ridge_geometry_not_vetoed_by_missing_wind(self):
        rows,grids=fixture({'mslp_hpa':lambda x,y:1020-.3*x*x})
        baseline=diagnose(rows,grids,'surface')
        candidate=diagnose_v5(rows,grids,'2026-10-19T03:00:00Z')
        self.assertNotIn('ridge',{f['properties']['feature_type'] for f in baseline['features']})
        self.assertIn('ridge',{f['properties']['feature_type'] for f in candidate['features']})

    def test_engine_history_isolated_and_input_unchanged(self):
        rows,grids=fixture({'mslp_hpa':lambda x,y:1000+.25*(x*x+(y-15)**2)})
        old=diagnose_v5(rows,grids,'2026-10-19T00:00:00Z');before=copy.deepcopy(old)
        current=diagnose_v5(rows,grids,'2026-10-19T03:00:00Z',old,rows,grids,'2026-10-19T00:00:00Z')
        self.assertEqual(old,before)
        matched=[f for f in current['features'] if f['properties'].get('previous_feature_id')]
        self.assertTrue(matched)
        old_ids={f['properties']['feature_id'] for f in old['features']}
        self.assertTrue(all(f['properties']['previous_feature_id'] in old_ids for f in matched))

    def test_occlusion_and_stationarity_not_inherited(self):
        for subtype in ('occluded','stationary'):
            f={'type':'Feature','geometry':{'type':'LineString','coordinates':[[0,10],[0,20]]},'properties':{
                'feature_type':'front','label':'front','evidence':[],'theta_gradient_k_100km':3,
                'front_type':subtype,'tracking_status':'matched_candidate'}}
            result=apply_policy({'features':[f],'properties':{}},[],{},'2026-10-19T03:00:00Z')
            self.assertEqual(result['features'][0]['properties']['front_type'],'unclassified')

    def test_coexisting_low_axis_and_front_not_priority_suppressed(self):
        features=[{'type':'Feature','geometry':{'type':'LineString','coordinates':[[0,10],[0,20]]},'properties':{
            'feature_type':t,'label':t,'evidence':[],'theta_gradient_k_100km':3}} for t in ('trough','ridge','front')]
        result=apply_policy({'features':features,'properties':{}},[],{},'2026-10-19T03:00:00Z')
        self.assertEqual(len(result['features']),3)

    def test_builder_retains_v4_when_v5_fails(self):
        import build_observation_charts as builder
        rows,grids=fixture({'mslp_hpa':lambda x,y:1000+x*x,'temperature_c':lambda x,y:20+x*0})
        for i,row in enumerate(rows):row.update(station=str(i),source='Test',wind_kt=0,wind_from_deg=0)
        with tempfile.TemporaryDirectory() as folder,patch.object(builder,'diagnostic_grids',return_value=grids),patch.object(builder,'analysis_grid',return_value=None),patch('synoptic_v5.diagnose_v5',side_effect=RuntimeError('test only')):
            builder.build_chart(Path(folder),'surface',datetime.fromisoformat('2026-10-19T03:00:00Z'),rows,[],diagnostics_only=True)
            root=Path(folder)/'surface'/'2026101903'
            self.assertIn('v4',json.loads((root/'features.geojson').read_text())['properties']['method'])
            self.assertEqual(json.loads((root/'features-v5.geojson').read_text())['properties']['status'],'Challenger failed; V4 retained')

    def test_pair_report_not_validation_without_labels(self):
        from replay_observation_case import replay_pair
        rows,grids=fixture({'mslp_hpa':lambda x,y:1000+.25*(x*x+(y-15)**2)})
        baseline=diagnose(rows,grids,'surface')
        context=dict(rows=rows,grids=grids,previous_rows=[],previous_grids=None,previous_time=None,upper_rows=[])
        with patch('replay_observation_case.replay',return_value=(baseline,context)):
            a,b,report=replay_pair({},'2026-10-19T03:00:00Z')
        self.assertEqual(a['properties']['paired_input_sha256'],b['properties']['paired_input_sha256'])
        self.assertFalse(report['skill_validated']);self.assertEqual(report['evaluations']['v5']['status'],'pending_expert_review')
        self.assertEqual(a['properties']['common_fields_sha256'],b['properties']['common_fields_sha256'])

    def test_regional_domain_explicit_global_default_unchanged(self):
        import build_observation_charts as builder
        rows=[dict(latitude=lat,longitude=lon,mslp_hpa=1000+lon*.1) for lat in (10,12,14) for lon in (0,2,4)]
        x,y,z=builder.analysis_grid(rows,'mslp_hpa',1000,diagnostic=True,bounds=(-5,5,5,20))
        self.assertEqual(x[0],-5);self.assertEqual(x[-1],5.5);self.assertEqual(z.shape,(len(y),len(x)))
        with self.assertRaises(ValueError):builder.analysis_grid(rows,'mslp_hpa',1000,bounds=(170,5,-170,20))


if __name__=='__main__':unittest.main()
