"""Experimental, observation-supported synoptic diagnostics (not advisories).

Thresholds are explicit heuristics, not a validated cyclone/front classifier.
Feature support is much stricter than the background chart interpolation.
"""
import math
from datetime import datetime
import numpy as np
from scipy.ndimage import gaussian_filter, maximum_filter, minimum_filter, binary_erosion
from scipy.spatial import cKDTree
from diagnostic_math import gradients, vector_diagnostics

EARTH = 6371.


def xyz(lat, lon):
    a, b = np.radians(lat), np.radians(lon)
    return np.column_stack((np.cos(a)*np.cos(b), np.cos(a)*np.sin(b), np.sin(a)))


def wind_components(rows):
    for row in rows:
        speed, direction = row.get('wind_kt'), row.get('wind_from_deg')
        if speed is None or (direction is None and speed != 0):
            row['u_ms'] = row['v_ms'] = None
        else:
            angle = math.radians(direction or 0)
            row['u_ms'], row['v_ms'] = -speed/1.94384449*math.sin(angle), -speed/1.94384449*math.cos(angle)
    return rows


def support(rows, field, x, y, upper=False):
    samples = [r for r in rows if r.get(field) is not None and
               (upper or (r.get('elevation_m') or 0) <= 800)]
    shape = (len(y), len(x))
    if len(samples) < 6:
        return np.zeros(shape, bool), np.zeros(shape), np.full(shape, 1e6)
    lat, lon = np.array([r['latitude'] for r in samples]), np.array([r['longitude'] for r in samples])
    xx, yy = np.meshgrid(x, y)
    distance, ids = cKDTree(xyz(lat, lon)).query(xyz(yy.ravel(), xx.ravel()), k=min(32,len(samples)))
    km = 2*np.arcsin(np.clip(distance/2,0,1))*EARTH
    radius = 1100 if upper else 600
    within = km <= radius
    # Surrounding reports, not merely an extrapolated smooth patch.
    a, b = np.radians(yy.ravel()), np.radians(xx.ravel())
    sa, sb = np.radians(lat[ids]), np.radians(lon[ids])
    delta = sb-b[:,None]
    bearing = np.arctan2(np.sin(delta)*np.cos(sa), np.cos(a[:,None])*np.sin(sa)-np.sin(a[:,None])*np.cos(sa)*np.cos(delta))%(2*np.pi)
    angles = np.sort(np.where(within,bearing,np.inf),axis=1)
    count = within.sum(axis=1)
    with np.errstate(invalid='ignore'):
        gaps = np.diff(angles,axis=1)
        last = angles[np.arange(len(angles)),np.maximum(0,count-1)]
        maximum_gap = np.maximum(np.where(np.isfinite(gaps),gaps,0).max(axis=1),angles[:,0]+2*np.pi-last)
    valid = (count >= 6) & (km[:,0] <= (600 if upper else 250)) & (maximum_gap <= np.radians(190))
    valid = valid.reshape(shape) & (abs(yy)<75)
    return valid, count.reshape(shape), km[:,0].reshape(shape)


def background(z, valid, sigma=8):
    return gaussian_filter(np.where(valid,z,0),sigma,mode=('nearest','wrap'))/np.maximum(gaussian_filter(valid.astype(float),sigma,mode=('nearest','wrap')),1e-8)


def thin(image):
    """Zhang-Suen thinning, retaining connected candidate axes."""
    image = image.copy()
    for _ in range(50):
        changed = False
        for phase in (0,1):
            p = np.pad(image,1)
            n = [p[:-2,1:-1],p[:-2,2:],p[1:-1,2:],p[2:,2:],p[2:,1:-1],p[2:,:-2],p[1:-1,:-2],p[:-2,:-2]]
            count = sum(a.astype(np.uint8) for a in n)
            transition = sum((~n[i]&n[(i+1)%8]).astype(np.uint8) for i in range(8))
            first = (n[0]&n[2]&n[4]) if phase==0 else (n[0]&n[2]&n[6])
            second = (n[2]&n[4]&n[6]) if phase==0 else (n[0]&n[4]&n[6])
            remove = image & (count>=2)&(count<=6)&(transition==1)&~first&~second
            if remove.any(): image[remove]=False; changed=True
        if not changed: break
    return image


def paths(mask):
    pixels = set(zip(*np.nonzero(thin(mask))))
    def neighbours(node):
        a,b=node
        return sorted((a+da,b+db) for da,db in ((-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)) if (a+da,b+db) in pixels)
    graph = {p: neighbours(p) for p in pixels}
    visited = set()
    result = []
    starts = sorted(pixels,key=lambda p:(len(graph[p])==2,p))
    for start in starts:
        for next_node in graph[start]:
            if frozenset((start,next_node)) in visited: continue
            path=[start]; previous,current=start,next_node
            while True:
                visited.add(frozenset((previous,current))); path.append(current)
                options=[p for p in graph[current] if frozenset((current,p)) not in visited]
                if len(graph[current])!=2 or not options or current==start: break
                previous,current=current,options[0]
            if len(path)>=7: result.append(path)
    return result


def axis_mask(z, valid, x, y, ridge, flow=None):
    gx, gy = gradients(z,x,y)
    gxx,gxy=gradients(gx,x,y); gyx,gyy=gradients(gy,x,y)
    hessian=np.empty(z.shape+(2,2))
    metric=np.tan(np.radians(y))[:,None]/(EARTH*1000)
    hessian[...,0,0],hessian[...,1,1]=gxx-gy*metric,gyy
    hessian[...,0,1]=hessian[...,1,0]=(gxy+gyx+gx*metric)/2
    eigenvalues,vectors=np.linalg.eigh(hessian)
    index=0 if ridge else 1
    curvature=eigenvalues[...,index]
    normal=vectors[..., :,index]
    across=normal[...,0]*gx+normal[...,1]*gy
    # A relative floor, not a top-percentile selector: a broad, uniform trough
    # must not lose its axis merely because curvature is similar everywhere.
    threshold=.2*np.percentile(abs(curvature[valid]),65) if valid.any() else np.inf
    signed=curvature < -threshold if ridge else curvature > threshold
    # Allow up to one grid cell offset from the transverse extremum.
    result = valid & signed & (abs(across) < abs(curvature)*60000)
    if flow is not None:
        u,v=flow
        result &= abs(normal[...,0]*u+normal[...,1]*v) <= .6*np.maximum(np.hypot(u,v),1e-6)
        from scipy.ndimage import map_coordinates
        aa,bb=np.indices(z.shape)
        di=normal[...,1]*100/(111.195*(y[1]-y[0]))
        dj=normal[...,0]*100/(111.195*(x[1]-x[0])*np.maximum(.1,np.cos(np.radians(y)))[:,None])
        side0=map_coordinates(z,[aa-di,bb-dj],order=1,mode='nearest')
        side1=map_coordinates(z,[aa+di,bb+dj],order=1,mode='nearest')
        result &= (z>(side0+side1)/2+.1) if ridge else (z<(side0+side1)/2-.1)
    return result


def distance_km(a,b):
    chord=np.linalg.norm(xyz([a[1]],[a[0]])[0]-xyz([b[1]],[b[0]])[0])
    return 2*math.asin(min(1,chord/2))*EARTH


def diagnose(rows, grids, kind, level=None, smooth=lambda line:line, upper_rows=None, valid_time=None, pressure_axis_flow_required=True):
    first=next((g for g in grids.values() if g is not None),None)
    if first is None: return {'type':'FeatureCollection','features':[], 'properties':{'status':'No analysed fields'}}
    x,y=first[0][:-1],first[1]
    upper=kind=='upper'
    features=[]
    field='height_m' if upper else 'mslp_hpa'
    analysed=grids.get(field)
    z=np.asarray(analysed[2].filled(0))[:,:-1] if analysed is not None else np.zeros((len(y),len(x)))
    valid,count,nearest=support(rows,field,x,y,upper)
    if analysed is not None: valid &= ~np.ma.getmaskarray(analysed[2])[:,:-1]
    else: valid[:]=False
    # Erode support near gaps so derivatives do not infer boundaries there.
    valid=binary_erosion(valid,iterations=2)
    residual=z-background(z,valid)

    def properties(type_,label,a,b,evidence,**extra):
        return dict(feature_type=type_,label=label,confidence='moderate' if count[a,b]>=10 else 'limited',
                    observation_count=int(count[a,b]),nearest_observation_km=round(float(nearest[a,b])),
                    evidence=evidence,experimental=True,level_hpa=level,**extra)

    def add_lines(mask,type_,label,evidence,minimum_length=350,values=None):
        for path in paths(mask):
            line=np.array([[x[b],y[a]] for a,b in path])
            length=sum(distance_km(a,b) for a,b in zip(line[:-1],line[1:]))
            if length<minimum_length: continue
            a,b=path[len(path)//2]
            extra={'length_km':round(length)}
            if values is not None:
                extra['maximum_wind_kt']=round(max(float(values[a,b]) for a,b in path),1)
                extra['wind_to_deg']=round(math.degrees(math.atan2(u[a,b],v[a,b]))%360)
            features.append({'type':'Feature','geometry':{'type':'LineString','coordinates':np.round(smooth(line),4).tolist()},
                             'properties':properties(type_,label,a,b,evidence,**extra)})

    def grid(name):
        item=grids.get(name)
        return (np.asarray(item[2].filled(0))[:,:-1],~np.ma.getmaskarray(item[2])[:,:-1]) if item is not None else (None,None)
    u,umask=grid('u_ms'); v,vmask=grid('v_ms')
    wind_valid=np.zeros_like(valid); shear=None; convergence=None
    if u is not None and v is not None:
        wind_valid,wind_count,wind_nearest=support(rows,'u_ms',x,y,upper)
        wind_valid=binary_erosion(wind_valid & umask & vmask,iterations=2)
        flow=vector_diagnostics(u,v,x,y)
        ux,uy,vx,vy=(flow[key] for key in ('ux','uy','vx','vy'))
        shear=flow['vorticity']*np.sign(y)[:,None]; convergence=-flow['divergence']
    if valid.any():
        for ridge in (False,True):
            mask=axis_mask(z,valid,x,y,ridge) & ((residual> (15 if upper else .8)) if ridge else (residual<(-15 if upper else -.8)))
            if ridge and not upper and pressure_axis_flow_required:
                mask &= wind_valid & ((shear < -3e-6) | (convergence < -3e-6)) if shear is not None else False
            add_lines(mask,'ridge' if ridge else 'trough',('Upper-air ' if upper else 'Surface ')+('ridge' if ridge else 'trough'),
                      ['Transverse '+('height' if upper else 'pressure')+' extremum','Broad-field anomaly; surrounding reports']+(['Anticyclonic vorticity or divergent-flow support'] if ridge and not upper and pressure_axis_flow_required else []),500 if upper else 350)
    centers=[]
    if not upper and valid.any():
        for high in (False,True):
            filtered=maximum_filter(np.where(valid,z,-np.inf),size=13,mode=('nearest','wrap')) if high else minimum_filter(np.where(valid,z,np.inf),size=13,mode=('nearest','wrap'))
            candidates=list(zip(*np.nonzero(valid & (z==filtered) & ((residual>=2) if high else (residual<=-2)))))
            candidates.sort(key=lambda cell:abs(residual[cell]),reverse=True)
            accepted=[]
            for a,b in candidates:
                point=[x[b],y[a]]
                if any(distance_km(point,p)<400 for p in accepted): continue
                accepted.append(point)
                feature={'type':'Feature','geometry':{'type':'Point','coordinates':point},'properties':properties('high' if high else 'low','High' if high else 'Low',a,b,
                         ['Local pressure extremum over approximately 300 km','Pressure anomaly relative to broad surrounding field'],central_pressure_hpa=round(float(z[a,b]),1),pressure_anomaly_hpa=round(float(residual[a,b]),1))}
                features.append(feature)
                if not high: centers.append((a,b,feature))
                if len(accepted)>=30: break

    fronts=[]
    if not upper:
        from boundary_diagnostics import detect_boundaries
        boundaries=detect_boundaries(rows,grids,x,y,smooth)
        features.extend(boundaries)
        fronts=[f for f in boundaries if f['properties']['feature_type']=='front']
    if u is not None and v is not None:
        if upper and level in (300,250,200):
            speed=np.hypot(u,v)*1.94384449
            jet=axis_mask(speed,wind_valid,x,y,True,(u,v)) & (speed>=60)
            old_count,old_nearest=count,nearest; count,nearest=wind_count,wind_nearest
            add_lines(jet,'jet','Jet-stream candidate', ['Analysed wind ≥60 kt','Transverse wind-speed maximum; surrounding soundings'],600,speed)
            count,nearest=old_count,old_nearest
        elif not upper:
            # Diagnose circulation around each low from actual reports, not
            # interpolation alone. Do not infer cyclone type from latitude.
            for a,b,low in centers:
                point=low['geometry']['coordinates']
                reports=[]; sectors=set(); tangential=[]
                for row in rows:
                    if row.get('u_ms') is None: continue
                    distance=distance_km(point,[row['longitude'],row['latitude']])
                    if not 100<=distance<=600: continue
                    east=((row['longitude']-point[0]+180)%360-180)*math.cos(math.radians(point[1]))
                    north=row['latitude']-point[1]; norm=math.hypot(east,north)
                    rotation=1 if point[1]>=0 else -1
                    tangential.append(rotation*(-north*row['u_ms']+east*row['v_ms'])/max(norm,1e-6))
                    sectors.add(int((math.atan2(north,east)%(2*math.pi))/(math.pi/2)))
                    reports.append(row)
                if len(reports)<6 or len(sectors)<3 or np.mean(np.array(tangential)>0)<.7 or np.mean(tangential)<2: continue
                near_front=any(min(distance_km(point,p) for p in f['geometry']['coordinates'])<600 for f in fronts)
                from cyclone_environment import assess_cyclone
                assessment=assess_cyclone(point,upper_rows,valid_time or (rows[0].get('observed_at') if rows else None),near_front,float(vx[a,b]-uy[a,b]) if wind_valid[a,b] else None)
                type_,label_=assessment.pop('feature_type'),assessment.pop('label')
                evidence=['Pressure minimum','Cyclonic tangential winds at ≥70% of surrounding reports',f'{len(reports)} wind reports in {len(sectors)} quadrants']
                if near_front: evidence.append('Nearby independently detected frontal boundary')
                evidence+=assessment.pop('evidence')
                features.append({'type':'Feature','geometry':low['geometry'],'properties':properties(type_,label_,a,b,evidence,central_pressure_hpa=low['properties']['central_pressure_hpa'],**assessment)})
    return {'type':'FeatureCollection','features':features,'properties':{'method':'Experimental observation-supported diagnostics v4',
             'status':'Dew point available' if any(r.get('dewpoint_c') is not None for r in rows) else 'No dew point: moisture diagnostics unavailable; thermal boundaries remain eligible',
             'front_classification':'Candidate boundaries only; cold/warm/occluded type not established',
             'jet_threshold_kt':60,'feature_count':len(features)}}
