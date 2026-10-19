"""Experimental V5 challenger using V4 primitive extraction, not V4 classifications.

Same observation analysis; independent lineage, bounded closure, grouped evidence
and structural abstention. Scores are engineering indices, never probabilities.
"""
import copy
import heapq
import math
import uuid
import numpy as np
from scipy.ndimage import gaussian_filter
from synoptic_features import diagnose, distance_km
from temporal_diagnostics import enrich_temporal, nearest_on_line

VERSION = 'v5-experimental-1'
WEIGHTS = {
    'centre': {'pressure_structure':45, 'circulation':25, 'analysis_robustness':20, 'history':10},
    'axis': {'pressure_structure':50, 'circulation':20, 'analysis_robustness':20, 'history':10},
    'front': {'thermal_structure':40, 'dynamics':30, 'history':20, 'vertical':5, 'weather':5},
}


def evidence_score(family, memberships):
    groups={name:{'weight':weight, 'membership':memberships.get(name),
                  'state':'unknown' if memberships.get(name) is None else 'assessed',
                  'points':round(weight*float(memberships.get(name) or 0),2)}
            for name,weight in WEIGHTS[family].items()}
    if any(g['membership'] is not None and not 0<=g['membership']<=1 for g in groups.values()):
        raise ValueError('Evidence memberships must lie in [0,1]')
    score=round(sum(g['points'] for g in groups.values()),2)
    return dict(evidence_groups=groups,support_index=score,
                assessed_weight=sum(g['weight'] for g in groups.values() if g['state']=='assessed'),
                support_tier='supported_candidate' if score>=70 else 'provisional_candidate' if score>=50 else 'exploratory',
                probability=None,score_policy=VERSION,confidence='uncalibrated evidence index')


def enclosure(pressure, valid, x, y, point, high=False, radius_km=1000, max_depth=12):
    """Priority flood to first deeper extremum, unsupported edge or radius cap.

    Reports only supported enclosure-depth LOWER BOUND, not a global saddle
    prominence. Grid edges are never silently wrapped on regional grids.
    """
    a=int(np.argmin(abs(y-point[1])));b=int(np.argmin(abs(x-point[0])))
    z=np.asarray(pressure)*(-1 if high else 1)
    unknown={'closure_status':'unresolved','enclosure_depth_lower_bound_hpa':None}
    if not valid[a,b] or not np.isfinite(z[a,b]):return dict(unknown,termination='unsupported_centre')
    periodic=len(x)>2 and abs(len(x)*(x[1]-x[0]))>=359.9
    lon,lat=np.meshgrid(x,y)
    dlat=np.radians(lat-point[1]);dlon=np.radians(lon-point[0])
    distance=12742*np.arcsin(np.sqrt(np.clip(np.sin(dlat/2)**2+math.cos(math.radians(point[1]))*np.cos(np.radians(lat))*np.sin(dlon/2)**2,0,1)))
    start=float(z[a,b]);queue=[(start,a,b)];seen={(a,b)};extent=0.;count=0
    while queue:
        height,i,j=heapq.heappop(queue);depth=max(0.,height-start)
        reason=None
        if not valid[i,j]:reason='unsupported_edge'
        elif distance[i,j]>=radius_km:reason='radius_cap'
        elif z[i,j]<start-.05:reason='deeper_extremum_spill'
        elif depth>=max_depth:reason='depth_cap'
        if reason:
            closed=depth>=1 and extent>=50 and count>=9
            return {'closure_status':'supported_enclosure' if closed else 'unresolved',
                    'enclosure_depth_lower_bound_hpa':round(min(depth,max_depth),2) if closed else None,
                    'termination':reason,'supported_flood_cells':count,'tested_radius_km':radius_km}
        extent=max(extent,float(distance[i,j]))
        count+=1
        for di,dj in ((-1,0),(1,0),(0,-1),(0,1)):
            ni,nj=i+di,j+dj
            if periodic:nj%=len(x)
            if not (0<=ni<len(y) and 0<=nj<len(x)):
                # Escaping the analysed domain provides no additional enclosure.
                closed=depth>=1 and extent>=50 and count>=9
                return {'closure_status':'supported_enclosure' if closed else 'unresolved',
                        'enclosure_depth_lower_bound_hpa':round(depth,2) if closed else None,
                        'termination':'domain_edge','supported_flood_cells':count,'tested_radius_km':radius_km}
            if (ni,nj) in seen:continue
            seen.add((ni,nj))
            # Unsupported values must not create a fictitious enclosing wall.
            level=max(height,float(z[ni,nj])) if valid[ni,nj] and np.isfinite(z[ni,nj]) else height
            heapq.heappush(queue,(level,ni,nj))
    return dict(unknown,termination='no_supported_enclosure')


def circulation(rows, point, high=False):
    sites={}
    eligible=[r for r in rows if r.get('u_ms') is not None and r.get('v_ms') is not None]
    if eligible:
        lat=np.radians([r['latitude'] for r in eligible]);lon=np.radians([r['longitude'] for r in eligible])
        lat0=math.radians(point[1]);lon0=math.radians(point[0])
        km=12742*np.arcsin(np.sqrt(np.clip(np.sin((lat-lat0)/2)**2+np.cos(lat)*math.cos(lat0)*np.sin((lon-lon0)/2)**2,0,1)))
        for row,inside in zip(eligible,(km>=100)&(km<=600)):
            if inside:sites[(round(row['longitude'],2),round(row['latitude'],2))]=row
    sectors=set();tangential=[]
    for row in sites.values():
        east=((row['longitude']-point[0]+180)%360-180)*math.cos(math.radians(point[1]))
        north=row['latitude']-point[1];norm=math.hypot(east,north)
        sense=(1 if point[1]>=0 else -1)*(-1 if high else 1)
        tangential.append(sense*(-north*row['u_ms']+east*row['v_ms'])/max(norm,1e-8))
        sectors.add(int(math.atan2(north,east)%(2*math.pi)/(math.pi/2)))
    if len(sites)<6 or len(sectors)<3:
        return None,{'state':'unknown','unique_sites':len(sites),'quadrants':len(sectors)}
    fraction=float(np.mean(np.asarray(tangential)>0));speed=float(np.mean(tangential))
    supported=fraction>=.7 and speed>=2
    return float(supported),{'state':'pass' if supported else 'fail','unique_sites':len(sites),
                            'quadrants':len(sectors),'rotation_agreement':round(fraction,2),
                            'mean_tangential_ms':round(speed,2)}


def pressure_stability(z,valid,x,y,point,high=False,smoothed_fields=None):
    """Two smoothing perturbations only; not a complete error estimate."""
    a=int(np.argmin(abs(y-point[1])));b=int(np.argmin(abs(x-point[0])))
    periodic=len(x)>2 and abs(len(x)*(x[1]-x[0]))>=359.9
    values=[]
    for index,sigma in enumerate((.6,1.2)):
        mode=('nearest','wrap' if periodic else 'nearest')
        smoothed=smoothed_fields[index] if smoothed_fields is not None else gaussian_filter(np.where(valid,z,0),sigma,mode=mode)/np.maximum(gaussian_filter(valid.astype(float),sigma,mode=mode),1e-9)
        cells=[(i,j%len(x) if periodic else j) for i in range(max(0,a-3),min(len(y),a+4)) for j in range(b-3,b+4)
               if periodic or 0<=j<len(x)]
        cells=[(i,j) for i,j in cells if valid[i,j]]
        if not cells:return None
        best=(max if high else min)(cells,key=lambda ij:smoothed[ij])
        displacement=distance_km(point,[float(x[best[1]]),float(y[best[0]])])
        values.append(1. if displacement<=75 else .5 if displacement<=150 else 0.)
    return min(values)


def apply_policy(result,rows,grids,valid_time):
    """Policy can only downgrade inherited subtype claims, never weather-promote."""
    result=copy.deepcopy(result);features=result['features']
    pressure=grids.get('mslp_hpa');centres={};removed=set()
    if pressure is not None:
        x,y,grid=pressure;z=np.asarray(grid.filled(np.nan))[:,:-1];valid=~np.ma.getmaskarray(grid)[:,:-1]&np.isfinite(z)
        from synoptic_features import support
        observed,_,_=support(rows,'mslp_hpa',x[:-1],y);valid &= observed
        mode=('nearest','wrap' if abs(len(x[:-1])*(x[1]-x[0]))>=359.9 else 'nearest')
        smoothed_fields=[gaussian_filter(np.where(valid,z,0),sigma,mode=mode)/np.maximum(gaussian_filter(valid.astype(float),sigma,mode=mode),1e-9) for sigma in (.6,1.2)]
    for feature in features:
        p=feature['properties'];type_=p['feature_type']
        p.update(algorithm=VERSION,comparison_role='challenger',evidence_limitations=[])
        # Namespace every object and lineage reference so a review cannot cross engines.
        for name in ('feature_id','track_id','previous_feature_id','parent_track_id'):
            if p.get(name) and not str(p[name]).startswith('v5:'):p[name]='v5:'+str(p[name])
        if 'candidate_parent_track_ids' in p:
            p['candidate_parent_track_ids']=[v if str(v).startswith('v5:') else 'v5:'+str(v) for v in p['candidate_parent_track_ids']]
        if not p.get('feature_id'):
            p['feature_id']='v5:'+str(uuid.uuid5(uuid.NAMESPACE_URL,repr((valid_time,type_,feature['geometry']))))
        credible=p.get('tracking_status')=='matched_candidate'
        history=1. if credible else None
        if type_ in ('low','high'):
            point=feature['geometry']['coordinates'];high=type_=='high'
            if pressure is None:closure={'closure_status':'unresolved','enclosure_depth_lower_bound_hpa':None};robust=None
            else:
                closure=enclosure(z,valid,x[:-1],y,point,high)
                robust=pressure_stability(z,valid,x[:-1],y,point,high,smoothed_fields)
            flow,flow_evidence=circulation(rows,point,high)
            closed=closure['closure_status']=='supported_enclosure'
            p.update(closure=closure,circulation_evidence=flow_evidence,
                     eligibility={'pressure_extremum':'pass','closed_structure':'pass' if closed else 'unknown'},
                     **evidence_score('centre',{'pressure_structure':1. if closed else .5,
                         'circulation':flow,'analysis_robustness':robust,'history':history}))
            p['label']=('Closed high' if high else 'Closed low')+' candidate' if closed else ('Pressure maximum' if high else 'Pressure minimum')+' — closure unresolved'
            p['evidence_limitations']=['Enclosure is a supported lower bound, not full global saddle prominence',
                'Robustness tests smoothing only; QNH-removal sensitivity not assessed',
                'Circulation sites deduplicated by coordinates; cross-feed station fusion not implemented']
            centres[tuple(point)]=feature
        elif type_ in ('trough','ridge'):
            # Primitive extraction already checks transverse pressure geometry.
            p.update(**evidence_score('axis',{'pressure_structure':1.,'history':history}),
                     eligibility={'pressure_axis':'pass'},
                     evidence_limitations=['Axis circulation and perturbation robustness not independently assessed'])
        elif type_=='front':
            gradient=p.get('theta_gradient_k_100km')
            thermal=gradient is not None and math.isfinite(gradient) and gradient>=1.5
            if not thermal:
                p.update(feature_type='thermal_boundary',label='Thermal zone — frontal eligibility unresolved',front_type='unclassified',
                         eligibility={'thermal_structure':'unknown'},support_tier='exploratory')
                continue
            dynamics=1.  # V4 primitive is a thermal ribbon + independent deformation/flow test.
            vertical=1. if p.get('vertical_structure_status')=='lower_tropospheric_support' else None
            p.update(**evidence_score('front',{'thermal_structure':1.,'dynamics':dynamics,'history':history,'vertical':vertical}),
                     eligibility={'thermal_structure':'pass','dynamical_support':'pass','synoptic_origin':'unknown'})
            subtype=p.get('front_type','unclassified')
            if not credible or subtype=='occluded':subtype='unclassified'
            # A grid floor is not observational uncertainty; unresolved stationarity is not asserted.
            if subtype=='stationary':subtype='unclassified'
            p.update(front_type=subtype,label=(subtype.capitalize()+' front' if subtype!='unclassified' else 'Unclassified frontal')+' candidate')
            p['evidence_limitations']=['Shared V4 thermal/dynamical primitives; not independent feature extraction',
                'Coastal/terrain/outflow discrimination unresolved; synoptic origin not established',
                'Stationary/occluded subtype withheld pending adequate uncertainty/3-D geometry',
                'Weather codes not retained; no weather points awarded']
        elif type_ in ('cyclone','extratropical','warm_core','tropical'):
            # Rebuilt below from a co-located pressure object; discard V4 type shortcuts.
            removed.add(id(feature))
        else:
            p['support_tier']='exploratory'
            p['evidence_limitations']=['Primitive/context layer retained; no V5 calibrated score for this family']
    result['features']=[f for f in features if id(f) not in removed]
    for centre in centres.values():
        p=centre['properties']
        if p['feature_type']!='low' or p['closure']['closure_status']!='supported_enclosure' or p['circulation_evidence']['state']!='pass':continue
        point=centre['geometry']['coordinates'];associations=[]
        for front in result['features']:
            if front['properties']['feature_type']!='front':continue
            match=nearest_on_line(point,front['geometry']['coordinates'])
            if match and match[0]<=600:
                associations.append({'feature_id':front['properties']['feature_id'],'distance_km':round(match[0]),'state':'proximity_only_not_structural_proof'})
        p.update(cyclone_structure='unresolved',tropical_status='not_established',
                 structural_requirements={'baroclinic_association':'unknown','monsoon_environment':'unknown',
                    'organized_deep_convection':'unknown','deep_warm_core':'unknown'},associated_boundaries=associations)
        badge=copy.deepcopy(centre);bp=badge['properties']
        bp.update(feature_type='cyclone',label='Cyclonic low — structural type unresolved',
                  feature_id=p['feature_id']+':cyclone',track_id=p.get('track_id',p['feature_id'])+':cyclone',
                  parent_low_id=p['feature_id'])
        # Do not advertise a low's previous feature as a separate cyclone badge match.
        for name in ('previous_feature_id','parent_track_id','candidate_parent_track_ids'):bp.pop(name,None)
        bp['tracking_status']='context_badge_not_independently_tracked'
        result['features'].append(badge)
    result.setdefault('properties',{}).update(algorithm=VERSION,method='Experimental V5 challenger; shared V4 primitive extraction, independent V5 lineage and conservative evidence policy',
        valid_time=valid_time,feature_count=len(result['features']),skill_validated=False,
        score_weights=WEIGHTS,configuration={'enclosure_radius_km':1000,'enclosure_depth_cap_hpa':12,'minimum_enclosure_depth_hpa':1,
            'support_tier_threshold':70,'provisional_tier_threshold':50,'membership_calibration':'unvalidated engineering settings'},
        limitations=['Phase A implementation; not the entire V5 research specification',
                     'No automatic tropical, monsoon, stationary or occluded declaration without missing evidence',
                     'Support index is not probability; same source observations/diagnostic fields as V4'])
    return result


def diagnose_v5(rows,grids,valid_time,previous=None,previous_rows=None,previous_grids=None,previous_time=None,upper_rows=None,smooth=lambda line:line):
    rows=copy.deepcopy(rows)
    result=diagnose(rows,grids,'surface',smooth=smooth,upper_rows=upper_rows,valid_time=valid_time,pressure_axis_flow_required=False)
    if previous and previous.get('properties',{}).get('algorithm')!=VERSION:
        previous=None  # Never use V4 labels or an incompatible challenger as V5 history.
    result=enrich_temporal(result,rows,grids,copy.deepcopy(previous),copy.deepcopy(previous_rows or []),previous_grids,valid_time,previous_time,upper_rows)
    from airmass_regions import air_mass_regions
    result['features'].extend(air_mass_regions(rows,grids,valid_time))
    # Independent lineage reuses geometric matching, not V4 classification decisions.
    return apply_policy(result,rows,grids,valid_time)
