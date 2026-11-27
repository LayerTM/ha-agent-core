# What in Home Assistant's states is an alert, said once for everything that
# reports one: cc-alerts and cc-digest, through ha-anomalies.sh.
#
# Input: the parsed /api/states body. Output: one array of {key, critical, line}
# (a two-threshold rule adds `side`); nothing at all when the input is no list of
# states. `$c` holds the rules' options, and what was active last time (`prev`
# keys, `sides`) for the clear margins; with nothing active, no margin applies.
def anomalies($c):
  $c.prev as $prev | $c.sides as $sides
  | $c.batt as $batt | $c.battm as $battm | $c.tm as $tm | $c.co2m as $co2m | $c.hm as $hm
  | $c.water as $water | $c.nopen as $nopen
  | $c.tenab as $tenab | $c.tlow as $tlow | $c.thigh as $thigh | $c.tents as $tents
  | $c.co2 as $co2 | $c.henab as $henab | $c.hlow as $hlow | $c.hhigh as $hhigh
  | $c.offen as $offen | $c.watch as $watch
  |
def active($key): ($prev | index($key)) != null;
# The side of a two-threshold band an entity is alerting on, if any. A
# reading past either threshold raises that side; an active alert is held
# by its own side only. With no side on record, the reading decides.
def band($key; $v; $low; $high; $m):
    if $v < $low then "low"
    elif $v > $high then "high"
    elif active($key) | not then empty
    elif $sides[$key] != "low" and $v > $high - $m then "high"
    elif $sides[$key] != "high" and $v < $low + $m then "low"
    else empty end;
arrays | [ .[]
  | (.attributes.device_class // "") as $dc
  | (.state // "") as $st
  | (.entity_id) as $eid
  | (.attributes.friendly_name // .entity_id) as $name
  | (
      # Offline / network watch. Runs on EVERY entity — including the
      # unavailable/unknown ones the value checks below skip — because a
      # watched device dropping off is exactly the anomaly. For a
      # device_tracker, "not_home" also counts as down (e.g. the internet
      # gateway). Critical: always sent, even during quiet hours.
      ( if $offen and (($watch | index($eid)) != null)
           and ( $st == "unavailable" or $st == "unknown"
                 or ($st == "not_home" and ($eid | startswith("device_tracker."))) )
        then {key:("offline:" + $eid), critical:true,
              line:("Offline: " + $name)}
        else empty end ),
      # Value-based checks only make sense on an entity reporting a real
      # reading, so they skip unavailable/unknown/empty states.
      ( select($st != "unavailable" and $st != "unknown" and $st != "")
        | (((.state | tonumber?) // null)) as $num
        | (
            ( if ($batt > 0) and ($dc == "battery") and ($num != null)
                 and ($num < $batt or (active("battery:" + $eid) and $num < $batt + $battm))
              then {key:("battery:" + .entity_id), critical:false,
                    line:("Low battery: " + $name + " (" + ($num|tostring) + "%)")}
              else empty end ),
            ( if $water and ($dc == "moisture") and ($st == "on")
              then {key:("leak:" + .entity_id), critical:true,
                    line:("WATER LEAK detected: " + $name)}
              else empty end ),
            ( if $nopen and ($st == "on")
                 and ($dc == "door" or $dc == "window" or $dc == "garage_door" or $dc == "opening")
              then {key:("night_open:" + .entity_id), critical:false,
                    line:("Open at night: " + $name)}
              else empty end ),
            ( if $tenab and ($dc == "temperature") and ($num != null)
                 and (($tents | length) == 0 or (($tents | index($eid)) != null))
              then ("temp:" + $eid) as $key
                 | band($key; $num; $tlow; $thigh; $tm) as $side
                 | {key:$key, critical:false, side:$side,
                    line:("Temperature out of range: " + $name + " (" + ($num|tostring) + "°)")}
              else empty end ),
            ( if ($co2 > 0) and ($dc == "carbon_dioxide") and ($num != null)
                 and ($num > $co2 or (active("co2:" + $eid) and $num > $co2 - $co2m))
              then {key:("co2:" + .entity_id), critical:false,
                    line:("High CO2: " + $name + " (" + ($num|tostring) + " ppm)")}
              else empty end ),
            ( if $henab and ($dc == "humidity") and ($num != null)
              then ("humidity:" + $eid) as $key
                 | band($key; $num; $hlow; $hhigh; $hm) as $side
                 | {key:$key, critical:false, side:$side,
                    line:("Humidity out of range: " + $name + " (" + ($num|tostring) + "%)")}
              else empty end )
          )
      )
    )
];
