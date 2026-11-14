from lunar.dem.pds_label import find_object, parse_label, parse_value

# Trimmed from the real LDEM_75S_240M_FLOAT.LBL, keeping the awkward parts:
# multi-line quoted and braced values, comments, units, nested objects.
REAL_LABEL_EXCERPT = '''PDS_VERSION_ID            = "PDS3"
PRODUCT_ID                = "LDEM_75S_240M"
MISSION_PHASE_NAME        = {"COMMISSIONING","NOMINAL MISSION","SCIENCE
                              MISSION"}
DESCRIPTION               = "This data product is a shape map (radius)
   of the Moon at a resolution of 240m/pix by 240m/pix."
OBJECT                    = UNCOMPRESSED_FILE
^IMAGE                    = "LDEM_75S_240M_FLOAT.IMG"
  OBJECT                  = IMAGE
    LINES                 = 3812
    LINE_SAMPLES          = 3812
    DERIVED_MINIMUM       = -7.765
    SAMPLE_TYPE           = PC_REAL
    UNIT                  = KILOMETER
    OFFSET                = 1737.4

/* HEIGHT = (DN * SCALING_FACTOR).                                         */

  END_OBJECT              = IMAGE
END_OBJECT                = UNCOMPRESSED_FILE

OBJECT                    = IMAGE_MAP_PROJECTION
 MAP_PROJECTION_TYPE          = "POLAR STEREOGRAPHIC"
 CENTER_LATITUDE              = -90 <deg>
 MAP_SCALE                    = 240 <m/pix>
 LINE_PROJECTION_OFFSET       = 1905.5 <pix>
 FIRST_STANDARD_PARALLEL      = 'N/A'
END_OBJECT                    = IMAGE_MAP_PROJECTION

END
'''


def test_parse_value_types_and_units():
    assert parse_value("3812") == 3812
    assert parse_value("-7.765") == -7.765
    assert parse_value("240 <m/pix>") == 240
    assert parse_value("1905.5 <pix>") == 1905.5
    assert parse_value('"POLAR STEREOGRAPHIC"') == "POLAR STEREOGRAPHIC"
    assert parse_value("'N/A'") == "N/A"
    assert parse_value("PC_REAL") == "PC_REAL"


def test_nested_objects_and_values():
    label = parse_label(REAL_LABEL_EXCERPT)
    image = label["UNCOMPRESSED_FILE"]["IMAGE"]
    assert image["LINES"] == 3812
    assert image["SAMPLE_TYPE"] == "PC_REAL"
    assert image["OFFSET"] == 1737.4
    proj = label["IMAGE_MAP_PROJECTION"]
    assert proj["MAP_PROJECTION_TYPE"] == "POLAR STEREOGRAPHIC"
    assert proj["CENTER_LATITUDE"] == -90
    assert proj["LINE_PROJECTION_OFFSET"] == 1905.5


def test_multiline_values_do_not_swallow_following_keys():
    label = parse_label(REAL_LABEL_EXCERPT)
    assert label["DESCRIPTION"].startswith("This data product")
    assert "240m/pix" in label["DESCRIPTION"]
    assert label["MISSION_PHASE_NAME"].startswith("{")
    assert label["PRODUCT_ID"] == "LDEM_75S_240M"


def test_find_object_searches_nested():
    label = parse_label(REAL_LABEL_EXCERPT)
    assert find_object(label, "IMAGE")["LINES"] == 3812
    assert find_object(label, "IMAGE_MAP_PROJECTION")["MAP_SCALE"] == 240
