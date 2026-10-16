"""Conservative, experimental temporal fronts and thermal/moisture advection.

These heuristics do not establish official fronts or Lagrangian air-mass tracks.
All comparisons require two compatible, observation-supported snapshots.
"""
import math
from datetime import datetime
import numpy as np
from scipy.ndimage import binary_erosion
from synoptic_features import distance_km, gradients, support


def nearest_on_line(point, line):
    """Local tangent-plane projection, with longitude wrapping."""
    lat, lon = point[1], point[0]
    cosine = max(.2, math.cos(math.radians(lat)))
    def local(p):
        return np.array([((p[0]-lon+180) % 360-180)*111.195*cosine, (p[1]-lat)*111.195])
    best = None
    for a, b in zip(line[:-1], line[1:]):
        aa, bb = local(a), local(b)
        delta = bb-aa
        fraction = np.clip(-np.dot(aa, delta)/max(np.dot(delta, delta), 1e-9), 0, 1)
        q = aa+fraction*delta
        candidate = (float(np.linalg.norm(q)), [lon+q[0]/(111.195*cosine), lat+q[1]/111.195], delta)
        if best is None or candidate[0] < best[0]: best = candidate
    return best


def classify_front(normal_speed_kt, normal_flow_kt, temperature_change, contrast):
    """Positive normal is toward warmer air: advancing cold air gives cold front."""
    if contrast < 2 or not all(math.isfinite(v) for v in (normal_speed_kt, normal_flow_kt, temperature_change)):
        return 'unclassified'
    if abs(normal_speed_kt) <= 5 and abs(normal_flow_kt) <= 5:
        return 'stationary'
    if normal_speed_kt > 5 and normal_flow_kt > 2:
        return 'cold'
    if normal_speed_kt < -5 and normal_flow_kt < -2:
        return 'warm'
    return 'unclassified'


def occlusion_supported(previous_types, near_low, surface_sides_observed, warm_aloft):
    # Require previous distinct cold/warm arms plus surface and elevated structure.
    return {'cold', 'warm'}.issubset(previous_types) and near_low and surface_sides_observed and warm_aloft


def enrich_temporal(current, rows, grids, previous, previous_rows, previous_grids, current_time, previous_time, upper_rows=None):
    status = current.setdefault('properties', {})
    status['front_classification'] = 'Experimental temporal candidates; ambiguous boundaries remain unclassified'
    fronts = [f for f in current['features'] if f['properties']['feature_type'] == 'front']
    for front in fronts:
        front['properties'].update(front_type='unclassified', label='Unclassified front candidate')
    from feature_tracking import track_features, pressure_tendencies
    track_features(current,previous,current_time,previous_time)
    status['pressure_tendency']=pressure_tendencies(rows,previous_rows,current_time,previous_time)
    hours = (datetime.fromisoformat(current_time)-datetime.fromisoformat(previous_time)).total_seconds()/3600 if previous_time else 0
    if not previous or not previous_grids or not 3 <= hours <= 18:
        status['temporal_status'] = 'No compatible previous analysis 3–18 hours earlier; temporal layers unavailable'
        return current
    status.update(previous_time=previous_time, comparison_hours=hours)
    required = ('temperature_c', 'u_ms', 'v_ms')
    moisture_available=grids.get('dewpoint_c') is not None and previous_grids.get('dewpoint_c') is not None
    if any(grids.get(k) is None or previous_grids.get(k) is None for k in required):
        status['temporal_status'] = 'Missing temperature/moisture/wind fields in one analysis'
        return current
    first = grids['temperature_c']; x, y = first[0][:-1], first[1]
    for key in required:
        if not (np.array_equal(grids[key][0], previous_grids[key][0]) and np.array_equal(grids[key][1], previous_grids[key][1])):
            status['temporal_status'] = 'Incompatible grids; no temporal classification'
            return current
    def arrays(source):
        return {k: np.asarray(source[k][2].astype(float).filled(np.nan))[:, :-1] for k in required+(('dewpoint_c',) if moisture_available else ())}
    now, old = arrays(grids), arrays(previous_grids)
    valid = np.ones(now['temperature_c'].shape, bool)
    for key in required:
        current_support, _, _ = support(rows, key, x, y)
        old_support, _, _ = support(previous_rows, key, x, y)
        valid &= current_support & old_support & np.isfinite(now[key]) & np.isfinite(old[key])
    valid = binary_erosion(valid, iterations=2)
    moisture_valid=np.zeros_like(valid)
    if moisture_available:
        ns,_,_=support(rows,'dewpoint_c',x,y);os,_,_=support(previous_rows,'dewpoint_c',x,y)
        moisture_valid=binary_erosion(ns&os&np.isfinite(now['dewpoint_c'])&np.isfinite(old['dewpoint_c']),iterations=2)&valid
    # Derivatives cannot cross missing-analysis boundaries.
    tx, ty = gradients(np.nan_to_num(now['temperature_c']), x, y)
    dx, dy = gradients(np.nan_to_num(now['dewpoint_c']), x, y) if moisture_available else (np.zeros_like(tx),np.zeros_like(ty))
    def cell(point):
        lon = (point[0]+180) % 360-180
        return int(np.argmin(abs(y-point[1]))), int(np.argmin(abs(x-lon)))
    def sample(field, point, source=now):
        a, b = cell(point)
        return float(source[field][a, b]) if valid[a,b] else None
    previous_fronts = [f for f in previous.get('features', []) if f['properties']['feature_type'] == 'front']
    used = set()
    for front in sorted(fronts, key=lambda f: -f['properties'].get('length_km', 0)):
        line = front['geometry']['coordinates']; mid = line[len(line)//2]; a,b = cell(mid)
        p = front['properties']
        p.update(previous_time=previous_time, comparison_hours=hours)
        if not valid[a,b]:
            p['evidence'].append('Insufficient common temporal observation support')
            continue
        magnitude = math.hypot(tx[a,b], ty[a,b])
        if magnitude < 1e-5: continue
        nx, ny = tx[a,b]/magnitude, ty[a,b]/magnitude
        options = []
        for index, candidate in enumerate(previous_fronts):
            if index in used: continue
            match = nearest_on_line(mid, candidate['geometry']['coordinates'])
            if match is None or match[0] > min(650, hours*70): continue
            # Avoid matching crossing/near-perpendicular boundaries.
            tangent = match[2]/max(np.linalg.norm(match[2]), 1e-9)
            if abs(tangent[0]*nx+tangent[1]*ny) > .5: continue
            options.append((match[0], index, match[1]))
        options.sort()
        if not options or (len(options)>1 and options[1][0]-options[0][0] < 50):
            p['evidence'].append('Previous boundary missing or ambiguous')
            continue
        distance, index, prior = options[0]; used.add(index)
        previous_t = sample('temperature_c', prior, old); current_t = sample('temperature_c', prior)
        if previous_t is None or current_t is None: continue
        east = ((mid[0]-prior[0]+180)%360-180)*111.195*math.cos(math.radians(mid[1]))
        north = (mid[1]-prior[1])*111.195
        speed = (east*nx+north*ny)/hours/1.852
        flow = (now['u_ms'][a,b]*nx+now['v_ms'][a,b]*ny)*1.94384449
        contrast = magnitude*200000
        type_ = classify_front(speed, flow, current_t-previous_t, contrast)
        # Require agreement along the boundary, not one convenient midpoint.
        votes=[]; sampled_cells=set()
        for fraction in (.2,.35,.5,.65,.8):
            pt=line[min(len(line)-1,int((len(line)-1)*fraction))];sa,sb=cell(pt)
            if not valid[sa,sb] or (sa,sb) in sampled_cells:continue
            sampled_cells.add((sa,sb))
            match=nearest_on_line(pt,previous_fronts[index]['geometry']['coordinates'])
            if match is None or match[0]>min(650,hours*70):continue
            prior_pt=match[1];before_t=sample('temperature_c',prior_pt,old);after_t=sample('temperature_c',prior_pt)
            magnitude_=math.hypot(tx[sa,sb],ty[sa,sb])
            if before_t is None or after_t is None or magnitude_<1e-5:continue
            sx,sy=tx[sa,sb]/magnitude_,ty[sa,sb]/magnitude_
            east_=((pt[0]-prior_pt[0]+180)%360-180)*111.195*math.cos(math.radians(pt[1]));north_=(pt[1]-prior_pt[1])*111.195
            speed_=(east_*sx+north_*sy)/hours/1.852;flow_=(now['u_ms'][sa,sb]*sx+now['v_ms'][sa,sb]*sy)*1.94384449
            votes.append(classify_front(speed_,flow_,after_t-before_t,magnitude_*200000))
        agreement=votes.count(type_)/len(votes) if votes else 0
        if len(votes)<3 or agreement<.75:type_='unclassified'
        uncertainty=111.195*max(abs(y[1]-y[0]),abs(x[1]-x[0])*math.cos(math.radians(mid[1])))/2/hours/1.852
        if abs(speed)<=uncertainty and uncertainty>5:type_='unclassified'
        p.update(front_type=type_, label=(type_.capitalize()+' front candidate') if type_!='unclassified' else 'Unclassified front candidate',
                 normal_motion_kt=round(speed,1), normal_flow_kt=round(flow,1), temperature_change_c=round(current_t-previous_t,1),
                 normal_to_warm_deg=round(math.degrees(math.atan2(nx,ny))%360),classification_sample_count=len(votes),classification_agreement=round(agreement,2),motion_uncertainty_kt=round(uncertainty,1))
        p['evidence'] += [f'Matched boundary {distance:.0f} km away, {hours:g} hours earlier',
                          f'Normal motion toward warmer air: {speed:.1f} kt; normal wind: {flow:.1f} kt',
                          f'Temperature change at prior boundary: {current_t-previous_t:+.1f} °C',
                          f'Along-boundary agreement: {agreement:.0%} across {len(votes)} supported samples (minimum 3 and 75%)',
                          f'Grid-spacing floor on motion uncertainty: {uncertainty:.1f} kt; observation/analysis errors may be larger',
                          'Local temperature change is corroboration, not a mandatory cold/warm-front sign test',
                          'Heuristic classification; surface heating, coastlines and time sampling can still mimic frontal changes']
        # Check cross-front temperature at available lower-tropospheric sites.
        lower_sides={level:[{},{}] for level in (850,925)}
        for row in upper_rows or []:
            if row.get('level_hpa') not in (850,925) or row.get('temperature_c') is None:continue
            try:age=(datetime.fromisoformat(current_time)-datetime.fromisoformat(row['observed_at'])).total_seconds()
            except (KeyError,ValueError,TypeError):continue
            if not 0<=age<=12*3600 or distance_km(mid,[row['longitude'],row['latitude']])>500:continue
            east_=((row['longitude']-mid[0]+180)%360-180)*math.cos(math.radians(mid[1]));north_=row['latitude']-mid[1]
            side=int(east_*nx+north_*ny>0)
            theta_=(row['temperature_c']+273.15)*(1000/row['level_hpa'])**.2854
            lower_sides[row['level_hpa']][side][(row['latitude'],row['longitude'])]=theta_
        contrasts=[float(np.mean(list(sides[1].values()))-np.mean(list(sides[0].values()))) for sides in lower_sides.values() if all(len(side)>=3 for side in sides)]
        if contrasts:
            contrast_=min(contrasts)
            p['lower_level_theta_contrast_k']=round(contrast_,1)
            if contrast_<1:
                p.update(vertical_structure_status='shallow_or_tilted_or_unresolved',confidence='limited')
                p['evidence'].append('Upper-level contrast does not confirm surface orientation; shallow/tilted boundary retained, not vetoed')
            else:
                p['vertical_structure_status']='lower_tropospheric_support'
                p['evidence'].append('Available lower-tropospheric potential-temperature contrast supports surface orientation')
        else:
            p['confidence']='limited';p['vertical_structure_status']='unresolved';p['evidence'].append('Insufficient lower-tropospheric soundings to confirm vertical frontal structure')
        # Occlusion is NOT inferred merely because a front is near a low.
        nearby_types = {f['properties'].get('front_type') for f in previous_fronts
                         if (match := nearest_on_line(mid, f['geometry']['coordinates'])) and match[0] <= 300}
        near_low = any(distance_km(mid,f['geometry']['coordinates'])<=400 for f in current['features']
                       if f['properties']['feature_type']=='low')
        def offset(sign): return [mid[0]+sign*100*nx/(111.195*max(.2,math.cos(math.radians(mid[1])))),mid[1]+sign*100*ny/111.195]
        sides=[sample('temperature_c',offset(sign)) for sign in (-1,1)]
        # Occlusion lifts the warm sector: a surface warm midpoint is NOT required.
        cool_both = all(v is not None for v in sides)
        elevated=[]
        for sign in (-1,0,1):
            pt=offset(sign)
            reports={}
            for r in upper_rows or []:
                if r.get('level_hpa')!=850 or r.get('temperature_c') is None or distance_km(pt,[r['longitude'],r['latitude']])>150:continue
                try:age=(datetime.fromisoformat(current_time)-datetime.fromisoformat(r['observed_at'])).total_seconds()
                except (KeyError,ValueError,TypeError):continue
                if 0<=age<=12*3600:reports[(r['latitude'],r['longitude'])]=r['temperature_c']
            elevated.append(float(np.mean(list(reports.values()))) if len(reports)>=3 else None)
        warm_aloft = all(v is not None for v in elevated) and elevated[1]>=max(elevated[0],elevated[2])+2
        if len(votes)>=3 and agreement>=.75 and occlusion_supported(nearby_types, near_low, cool_both, warm_aloft):
            p.update(front_type='occluded', label='Occluded front candidate')
            p['evidence'].append('Prior cold/warm arms near low; supported elevated warm tongue; surface sides sampled without requiring a warm surface midpoint')
    # Sparse arrows visualize diagnosed advection, NOT traced parcel trajectories.
    advection=-(now['u_ms']*tx+now['v_ms']*ty)*86400
    moisture=np.where(moisture_valid,-(now['u_ms']*dx+now['v_ms']*dy)*86400,np.nan)
    region_valid=valid&(np.hypot(now['u_ms'],now['v_ms'])>=2)&(np.hypot(now['u_ms'],now['v_ms'])<=50)
    from airmass_regions import region_polygons
    for warming in (False,True):
        for moistening in (False,True,None):
            moisture_mask=~moisture_valid if moistening is None else moisture_valid&((moisture>=0) if moistening else (moisture<0))
            mask=region_valid&((advection>=2) if warming else (advection<=-2))&moisture_mask
            if not mask.any():continue
            props={'feature_type':'advection_region','label':('Warm' if warming else 'Cold')+' advection / '+('moisture unavailable' if moistening is None else 'moistening' if moistening else 'drying'),
                'warming':warming,'moistening':moistening,'previous_time':previous_time,'comparison_hours':hours,
                'mean_temperature_advection_c_day':round(float(np.mean(advection[mask])),1),
                'mean_temperature_change_c':round(float(np.mean((now['temperature_c']-old['temperature_c'])[mask])),1),
                'evidence':[f'Comparison interval: {hours:g} hours','Area has |thermal advection| ≥2 °C/day; moisture tendency gives the secondary class',
                            'Advection process, not a distinct source air mass; actual temperature changes may differ because of heating/mixing']}
            current['features'].extend(region_polygons(mask,x,y,props))
    # Moisture-dominated regions are kept, rather than omitted when thermal
    # advection is weak. They use a neutral thermal class.
    for moistening in (False,True):
        mask=region_valid&(abs(advection)<2)&((moisture>=2) if moistening else (moisture<=-2))
        if mask.any():current['features'].extend(region_polygons(mask,x,y,{'feature_type':'advection_region',
            'label':('Moistening' if moistening else 'Drying')+' advection / weak thermal advection','warming':None,'moistening':moistening,
            'previous_time':previous_time,'comparison_hours':hours,'evidence':['|Dew-point advection| ≥2 °C/day, |thermal advection| <2 °C/day','Wind-guided process; not a tracked parcel']}))
    added=0
    for a in range(4,len(y)-4,8):
      for b in range(0,len(x),8):
        if not valid[a,b] or (abs(advection[a,b])<2 and (not moisture_valid[a,b] or abs(moisture[a,b])<2)): continue
        u,v=now['u_ms'][a,b],now['v_ms'][a,b]; speed=math.hypot(u,v)
        if speed<2 or speed>50: continue
        # Two-hour wind-guided indicator, capped at 150 km, independent of snapshot gap.
        length=min(150,speed*7.2); cosine=max(.2,math.cos(math.radians(y[a])))
        end=[x[b]+length*u/speed/(111.195*cosine),y[a]+length*v/speed/111.195]
        warming=advection[a,b]>=0
        current['features'].append({'type':'Feature','geometry':{'type':'LineString','coordinates':[[float(x[b]),float(y[a])],end]},
          'properties':{'feature_type':'airmass','label':('Warm' if warming else 'Cold')+' advection · '+('moisture unavailable' if not moisture_valid[a,b] else 'moistening' if moisture[a,b]>=0 else 'drying'),
            'experimental':True,'confidence':'limited','observation_count':None,'nearest_observation_km':None,
            'previous_time':previous_time,'comparison_hours':hours,'warming':bool(warming),
            'wind_to_deg':round(math.degrees(math.atan2(u,v))%360),
            'temperature_advection_c_day':round(float(advection[a,b]),1),'dewpoint_advection_c_day':round(float(moisture[a,b]),1) if moisture_valid[a,b] else None,
            'temperature_change_c':round(float(now['temperature_c'][a,b]-old['temperature_c'][a,b]),1),
            'dewpoint_change_c':round(float(now['dewpoint_c'][a,b]-old['dewpoint_c'][a,b]),1) if moisture_valid[a,b] else None,
            'evidence':[f'Comparison interval: {hours:g} hours',f'Thermal advection: {advection[a,b]:+.1f} °C/day; moisture advection: {moisture[a,b]:+.1f} °C/day',
              f'Observed-analysis temperature change: {now["temperature_c"][a,b]-old["temperature_c"][a,b]:+.1f} °C; moisture support: {bool(moisture_valid[a,b])}',
              'Wind-guided advection indicator, not a tracked parcel or named source air mass; heating/mixing may oppose advection']}})
        added+=1
        if added>=150: break
      if added>=150: break
    status.update(temporal_status=f'Temporal comparison {hours:g} hours; experimental classifications and advection',feature_count=len(current['features']))
    return current
