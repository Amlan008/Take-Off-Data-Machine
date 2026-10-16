"""Independent boundary families; initial heuristics, not calibrated probabilities."""
import math
import numpy as np
from scipy.ndimage import binary_erosion, map_coordinates
from diagnostic_math import vector_diagnostics


def detect_boundaries(rows,grids,x,y,smooth=lambda line:line):
    from synoptic_features import support,gradients,background,axis_mask,paths,distance_km
    features=[]
    def field(name):
        grid=grids.get(name)
        if grid is None:return None,None,None,None
        values=np.asarray(grid[2].astype(float).filled(0))[:,:-1]
        valid,count,nearest=support(rows,name,x,y)
        valid=binary_erosion(valid&~np.ma.getmaskarray(grid[2])[:,:-1],iterations=2)
        return values,valid,count,nearest
    theta,thermal_valid,count,nearest=field('theta_k')
    u,uv,uc,un=field('u_ms');v,vv,_,_=field('v_ms')
    flow=vector_diagnostics(u,v,x,y,theta) if u is not None and v is not None else None
    wind_valid=uv&vv if flow is not None else None
    def add(mask,type_,label,evidence,counts,distances,extra=None):
        for path in paths(mask):
            line=np.array([[x[b],y[a]] for a,b in path]);a,b=path[len(path)//2]
            length=sum(distance_km(p,q) for p,q in zip(line[:-1],line[1:]))
            if length<250:continue
            props=dict(feature_type=type_,label=label,experimental=True,confidence='limited',
                observation_count=int(counts[a,b]),nearest_observation_km=round(float(distances[a,b])),
                length_km=round(length),evidence=list(evidence),line_placement='analysed boundary axis, not an exact warm-edge location',
                support_dimensions={'observations':'surrounding reports','analysis':'multi-scale' if type_ in ('front','thermal_boundary') else 'single supported scale','vertical':'not assessed','probability':'not calibrated'})
            if extra:props.update(extra(a,b,path))
            features.append({'type':'Feature','geometry':{'type':'LineString','coordinates':np.round(smooth(line),4).tolist()},'properties':props})
    if theta is not None:
        tx,ty=gradients(theta,x,y);gradient=np.hypot(tx,ty)
        coarse=background(theta,thermal_valid,sigma=2)
        cx,cy=gradients(coarse,x,y);cg=np.hypot(cx,cy)
        agreement=(tx*cx+ty*cy)/np.maximum(gradient*cg,1e-12)
        # Resolve a local gradient ridge, not every point on a broad polar gradient.
        ribbon=thermal_valid&(gradient>=1.5e-5)&(cg>=.75e-5)&(agreement>=.5)
        ribbon &= axis_mask(gradient,thermal_valid,x,y,True)
        add(ribbon,'thermal_boundary','Thermal boundary / baroclinic zone',
            ['Potential-temperature gradient ≥1.5 K/100 km','Direction and gradient persist after additional smoothing',
             'No dew-point, pressure-trough or wind-shift requirement; terrain and diurnal effects remain possible'],count,nearest,
            lambda a,b,path:dict(theta_gradient_k_100km=round(float(gradient[a,b]*1e5),2)))
        if flow is not None:
            nx,ny=tx/np.maximum(gradient,1e-12),ty/np.maximum(gradient,1e-12)
            aa,bb=np.indices(theta.shape)
            di=ny*100/(111.195*(y[1]-y[0]));dj=nx*100/(111.195*(x[1]-x[0])*np.maximum(.1,np.cos(np.radians(y)))[:,None])
            sides=[];supported=np.ones_like(thermal_valid)
            for sign in (-1,1):
                coords=np.array([aa+sign*di,bb+sign*dj])
                # Explicitly exclude off-domain samples; do not invent edge support.
                supported &= (coords[0]>=0)&(coords[0]<=len(y)-1)&(coords[1]>=0)&(coords[1]<=len(x)-1)
                sides.append((map_coordinates(u,coords,order=1,mode='nearest'),map_coordinates(v,coords,order=1,mode='nearest')))
                supported &= map_coordinates(wind_valid.astype(float),coords,order=0,mode='nearest')>.5
            (u0,v0),(u1,v1)=sides
            angle=np.degrees(np.arccos(np.clip((u0*u1+v0*v1)/np.maximum(np.hypot(u0,v0)*np.hypot(u1,v1),1e-9),-1,1)))
            shift=(angle>=15)&(np.minimum(np.hypot(u0,v0),np.hypot(u1,v1))>=2)
            cyclonic=flow['vorticity']*np.sign(y)[:,None]>=.8e-5
            convergent=flow['divergence']<=-.5e-5
            fg=flow['frontogenesis_k_100km_3h']
            # Alternatives, not a mandatory humidity + wind-angle + trough conjunction.
            frontal=ribbon&wind_valid&supported&((shift&(cyclonic|convergent))|(fg>=.5))
            add(frontal,'front','Potential frontal boundary',
                ['Thermal gradient with independent wind/deformation evidence','Humidity is corroboration, not a mandatory thermal-front input',
                 'Horizontal frontogenesis excludes vertical tilting and diabatic effects; frontolysis does not erase an existing front'],count,nearest,
                lambda a,b,path:dict(theta_gradient_k_100km=round(float(gradient[a,b]*1e5),2),
                    wind_shift_deg=round(float(angle[a,b]),1),frontogenesis_k_100km_3h=round(float(np.mean([fg[i,j] for i,j in path])),3),
                    frontogenesis_state='strengthening' if fg[a,b]>.1 else 'weakening' if fg[a,b]<-.1 else 'near neutral',
                    vertical_structure_status='unresolved'))
    moisture,mvalid,mc,mn=field('mixing_ratio_gkg')
    if moisture is not None:
        qx,qy=gradients(moisture,x,y);qg=np.hypot(qx,qy)
        add(mvalid&(qg>=1e-5)&axis_mask(qg,mvalid,x,y,True),'moisture_boundary','Moisture boundary — origin/type unresolved',
            ['Mixing-ratio gradient ≥1 g/kg per 100 km','Not automatically a dryline or a thermal front'],mc,mn)
    if flow is not None:
        strength=np.maximum(-flow['divergence'],abs(flow['vorticity']))
        add(wind_valid&(strength>=1e-5)&axis_mask(strength,wind_valid,x,y,True),
            'wind_boundary','Wind convergence / shear boundary',
            ['Supported convergence or vorticity ribbon','Wind structure alone does not establish a front'],uc,un)
    return features
