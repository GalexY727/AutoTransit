/v4/vehicles​

Returns real-time vehicle positions for a given route
Query Parameters

    global_route_id
    Type: string
    required

    Global route ID to get vehicles for
    direction_id
    Type: integerenum

    Optional direction ID to filter vehicles by direction
    values
        0
        1

Responses

    application/json

    List of vehicles for the route
    Type: object
        vehicles
        Type: array object[]
        required
            direction_id
            Type: integerenum
            required

            Direction of travel for this vehicle. 0 = Outbound, 1 = Inbound
            values
                0
                1
            latitude
            Type: numberFormat: float
            required

            Latitude of the vehicle
            longitude
            Type: numberFormat: float
            required

            Longitude of the vehicle
            updated_at
            Type: integer
            required

            Unix timestamp of when the vehicle position was last updated
            vehicle_id
            Type: string
            required

            Unique internal identifier for the vehicle, combining feed_code, global route id, and internal vehicle id
            external_vehicle_id
            Type: string nullable

            External vehicle identifier from the transit operator. May be null.
            occupancy_status
            Type: integerenum nullable

            Occupancy status of the vehicle. May be null if unavailable. 1 = Not crowded, 2 = Some crowding, 3 = Crowded
            values
                1
                2
                3
            rt_trip_id
            Type: string nullable

            Real-time trip identifier. May be null. If multiple trip IDs are assigned, returns the first one.
            vehicle_label
            Type: string nullable

            Vehicle identifier as provided by the operator. May be null.
            wheelchair_accessible
            Type: integerenum nullable

            Whether the vehicle is accessible. May be null if unavailable. Note: this only reflects real-time data for the specific vehicle. Routes with unknown values may be accessible if defined in static data. 0 = Unknown, 1 = Available (accessible), 2 = NotAvailable (inaccessible)
            values
                0
                1
                2

Example output:

```json
{
  "vehicles": [
    {
      "vehicle_id": "STM:980:1|29088",
      "latitude": 45.51379,
      "longitude": -73.683243,
      "direction_id": 0,
      "updated_at": 1764097776,
      "vehicle_label": "29-088",
      "occupancy_status": 1,
      "wheelchair_accessible": 1,
      "external_vehicle_id": "29088",
      "rt_trip_id": "292679910"
    }
  ]
}
```