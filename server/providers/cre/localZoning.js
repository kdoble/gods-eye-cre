import { arcgisQuery } from './common/arcgis.js';
import { arcgisPolygonFeature } from './hazards.js';
import { LOCAL_JURISDICTIONS, LOCAL_PACKAGE_VERSION } from './jurisdictions.js';

const MAX_MATCHES = 5;

async function pointPolygons(source, fields, requiredField, site, options) {
  const body = await arcgisQuery(
    source,
    {
      geometry: `${site.lon},${site.lat}`,
      geometryType: 'esriGeometryPoint',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: fields,
      returnGeometry: true,
      resultRecordCount: MAX_MATCHES + 1,
    },
    { ...options, retries: 0, timeoutMs: 12_000 },
  );
  if (!Array.isArray(body.features))
    throw new Error('Local GIS response invalid');
  const partial =
    body.exceededTransferLimit === true || body.features.length > MAX_MATCHES;
  const features = body.features.slice(0, MAX_MATCHES).map((f) => {
    if (!f?.geometry?.rings?.length || f.attributes?.[requiredField] == null)
      return null;
    return arcgisPolygonFeature(f.geometry, f.attributes);
  });
  if (features.some((f) => !f))
    throw new Error('Local GIS schema or geometry mismatch');
  return { features, partial };
}

export async function loadLocalParcelZoning(site, jurisdiction, options = {}) {
  const entry = LOCAL_JURISDICTIONS.find(
    (item) => item.id === jurisdiction?.id,
  );
  if (!entry) {
    return {
      status:
        jurisdiction?.status === 'unavailable' ? 'unavailable' : 'unsupported',
      parcelStatus: 'unsupported',
      zoningStatus: 'unsupported',
      features: [],
      parcelFeatures: [],
      zoningFeatures: [],
      sourceUrls: jurisdiction?.sourceUrls || [],
      packageVersion: LOCAL_PACKAGE_VERSION,
      message:
        jurisdiction?.message ||
        'No tested municipal parcel or zoning package for this point.',
    };
  }
  const zoningPromise = pointPolygons(
    entry.zoning,
    entry.id === 'dallas-tx' ? 'LONG_ZONE_DIST' : 'ZONECLASS,ZONEDESC',
    entry.zoningField,
    site,
    options,
  );
  const parcelPromise = entry.parcel
    ? pointPolygons(
        entry.parcel,
        'PIN,SITEADDRESS,ZONING,ACRES,GIS_ACRES',
        'PIN',
        site,
        options,
      )
    : Promise.resolve(null);
  const [zoning, parcel] = await Promise.allSettled([
    zoningPromise,
    parcelPromise,
  ]);
  const zoningValue = zoning.status === 'fulfilled' ? zoning.value : null;
  const parcelValue = parcel.status === 'fulfilled' ? parcel.value : null;
  const zoningStatus = !zoningValue
    ? 'unavailable'
    : zoningValue.partial
      ? 'partial'
      : zoningValue.features.length
        ? 'ready'
        : 'empty';
  const parcelStatus = !entry.parcel
    ? 'unsupported'
    : !parcelValue
      ? 'unavailable'
      : parcelValue.partial
        ? 'partial'
        : parcelValue.features.length
          ? 'ready'
          : 'empty';
  const zoningFeatures = zoningValue?.features || [];
  const parcelFeatures = parcelValue?.features || [];
  const failed =
    zoningStatus === 'unavailable' || parcelStatus === 'unavailable';
  return {
    status: failed
      ? zoningFeatures.length || parcelFeatures.length
        ? 'partial'
        : 'unavailable'
      : zoningStatus === 'partial' || parcelStatus === 'partial'
        ? 'partial'
        : zoningFeatures.length || parcelFeatures.length
          ? 'ready'
          : 'empty',
    features: [...parcelFeatures, ...zoningFeatures],
    parcelFeatures,
    zoningFeatures,
    parcelStatus,
    zoningStatus,
    jurisdictionId: entry.id,
    packageVersion: LOCAL_PACKAGE_VERSION,
    source: entry.zoning,
    zoningSource: entry.zoning,
    parcelSource: entry.parcel || null,
    sourceUrls: [entry.zoning, entry.parcel, entry.boundary].filter(Boolean),
    sourceMetadata: {
      publisher:
        entry.id === 'dallas-tx'
          ? 'City of Dallas GIS'
          : 'City of Atlanta Planning GIS',
      coverage: entry.name,
      recordDate: null,
      recordDateStatus: 'not-published-in-queried-fields',
      checkedAt: new Date().toISOString(),
      packageVersion: LOCAL_PACKAGE_VERSION,
    },
    crossesBoundary: jurisdiction.crossesBoundary,
    message: `${entry.name} parcel/zoning GIS at the selected point (parcel: ${parcelStatus}; zoning: ${zoningStatus}). The queried zoning response does not supply an effective or record date; verify the current governing record. Mapped zoning is a screening observation, not an entitlement or development-yield conclusion. ${jurisdiction.crossesBoundary ? 'The study ring crosses the city boundary; local coverage applies only within city limits.' : ''}`,
  };
}
