"""Gray-style environment factors, NOT Gray's seasonal genesis index/probability.

No observations of SST/heat-content or organized convection are fabricated.
Structural classification never emits a tropical-cyclone declaration.
"""
import math
from datetime import datetime
import numpy as np


def assess_cyclone(point,upper_rows,valid_time,near_front,vorticity=None):
    from synoptic_features import distance_km
    def fresh(row):
        if not valid_time or not row.get('observed_at'): return False
        try: return 0 <= (datetime.fromisoformat(valid_time)-datetime.fromisoformat(row['observed_at'])).total_seconds() <= 12*3600
        except (ValueError,TypeError): return False
    rows=[r for r in upper_rows or [] if fresh(r) and distance_km(point,[r['longitude'],r['latitude']])<=1200]
    def local(level,field,radius=600):
        # Unique sites, not duplicated/interpolated counts from the same profile.
        sites={ (round(r['latitude'],2),round(r['longitude'],2)):r for r in rows
            if r.get('level_hpa')==level and r.get(field) is not None and distance_km(point,[r['longitude'],r['latitude']])<=radius }
        return list(sites.values())
    def check(state,value=None,units=None,reason=None):
        return dict(state=state,value=value,units=units,reason=reason)
    factors={
      'coriolis':check('favourable' if abs(point[1])>=5 else 'unfavourable',round(2*7.2921159e-5*math.sin(math.radians(point[1])),7),'s-1','Latitude is an environmental factor, not cyclone type'),
      'cyclonic_vorticity':check('unavailable' if vorticity is None else 'favourable' if vorticity*math.copysign(1,point[1] or 1)>=1e-5 else 'unfavourable',round(vorticity,7) if vorticity is not None else None,'s-1','Initial diagnostic threshold, not a calibrated genesis probability'),
      'deep_layer_shear':check('unavailable',reason='Requires ≥3 co-located 850/200 hPa wind profiles'),
      'midlevel_humidity':check('unavailable',reason='Requires ≥3 local 600–700 hPa humidity profiles'),
      'moist_instability':check('unavailable',reason='Requires ≥3 paired 850/500 hPa T/Td profiles; proxy, not CAPE'),
      'ocean_heat':check('unavailable',reason='No SST/subsurface-ocean-heat feed configured'),
      'organized_convection':check('unavailable',reason='No organized deep-convection observation feed configured')}
    def paired(level,field):return {(round(r['latitude'],2),round(r['longitude'],2)):r for r in local(level,field)}
    lower,upper=paired(850,'wind_kt'),paired(200,'wind_kt'); shear=[]
    for key in lower.keys()&upper.keys():
        lo,hi=lower[key],upper[key]
        if lo.get('wind_from_deg') is None or hi.get('wind_from_deg') is None:continue
        def uv(r):a=math.radians(r['wind_from_deg']);return np.array([-math.sin(a),-math.cos(a)])*r['wind_kt']/1.94384449
        shear.append(float(np.linalg.norm(uv(hi)-uv(lo))))
    if len(shear)>=3:
        value=float(np.median(shear));factors['deep_layer_shear']=check('favourable' if value<10 else 'unfavourable',round(value,1),'m/s','Median co-located 850–200 hPa vector shear; 10 m/s diagnostic threshold')
    humidity={}
    for level in (600,700):
        for r in local(level,'relative_humidity_pct'):humidity.setdefault((r['latitude'],r['longitude']),[]).append(r['relative_humidity_pct'])
    if len(humidity)>=3:
        value=float(np.mean([np.mean(v) for v in humidity.values()])); factors['midlevel_humidity']=check('favourable' if value>=60 else 'unfavourable',round(value,1),'%','600–700 hPa RH; 60% initial proxy threshold, not original Gray index')
    from airmass_regions import thermodynamics
    lower,upper=paired(850,'temperature_c'),paired(500,'temperature_c'); instability=[]
    for key in lower.keys()&upper.keys():
        a,b=lower[key],upper[key];lo=thermodynamics(a.get('temperature_c'),a.get('dewpoint_c'),850);hi=thermodynamics(b.get('temperature_c'),b.get('dewpoint_c'),500)
        # This is a moist-stratification proxy, never a sufficient convection test.
        if lo and hi:instability.append(lo['theta_e_k']-hi['theta_e_k'])
    if len(instability)>=3:
        value=float(np.median(instability));factors['moist_instability']=check('proxy_positive' if value>0 else 'proxy_nonpositive',round(value,1),'K','850 minus 500 hPa theta-e; not parcel buoyancy or proof of convection')
    thermal=[]
    for level in (850,500,200):
        core=local(level,'temperature_c',400)
        outer=[r for r in rows if r.get('level_hpa')==level and r.get('temperature_c') is not None and 600<=distance_km(point,[r['longitude'],r['latitude']])<=1200]
        outer=list({(r['latitude'],r['longitude']):r for r in outer}.values())
        sectors={int((math.atan2(r['latitude']-point[1],((r['longitude']-point[0]+180)%360-180)*math.cos(math.radians(point[1])))%(2*math.pi))/(math.pi/2)) for r in outer}
        if len(core)<3 or len(outer)<6 or len(sectors)<3:continue
        def design(reports):return np.array([[1,r['latitude']-point[1],((r['longitude']-point[0]+180)%360-180)*math.cos(math.radians(point[1]))] for r in reports])
        matrix=design(outer)
        if np.linalg.matrix_rank(matrix)<3:continue
        fit=np.linalg.lstsq(matrix,[r['temperature_c'] for r in outer],rcond=None)[0]
        # Remove the environmental meridional/zonal gradient before core comparison.
        anomaly=float(np.mean(np.array([r['temperature_c'] for r in core])-design(core)@fit))
        thermal.append({'level_hpa':level,'anomaly_c':round(anomaly,2)})
    warm=any(v['level_hpa']==850 and v['anomaly_c']>=2 for v in thermal) and any(v['level_hpa'] in (500,200) and v['anomaly_c']>=2 for v in thermal)
    type_='extratropical' if near_front else 'warm_core' if warm else 'cyclone'
    return {'feature_type':type_,'label':{'extratropical':'Frontal cyclonic low — extratropical candidate','warm_core':'Warm-core low — type uncertain','cyclone':'Cyclonic low — type uncertain'}[type_],
      'thermal_structure':thermal,'gray_factors':factors,'genesis_assessment':'incomplete; not a genesis probability or tropical-cyclone classification',
      'latitude_caution':bool(abs(point[1])>40),'tropical_status':'not_established',
      'evidence':['Core anomalies are detrended against surrounding soundings, not raw latitude-biased means',
       'Missing front detection is not evidence of a non-frontal system',
       'Warm core does not establish tropical status; ocean heat and organized convection are unassessed']+
       (['Poleward of 40°: latitude caution, not automatic tropical/extratropical classification'] if abs(point[1])>40 else [])}
