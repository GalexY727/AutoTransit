/v4/public/plan​

This endpoint returns a plan from the origin to the destination in different modes, including multimodal trips.

Query Parameters

    from_lat
    Type: numberFormat: double

    Latitude of the starting location for the trip. Required unless from_global_stop_id or from_global_stop_ids is provided.
    from_lon
    Type: numberFormat: double

    Longitude of the starting location for the trip. Required unless from_global_stop_id or from_global_stop_ids is provided.
    from_global_stop_id
    Type: string

    Single global stop ID for the starting location. Kept for backward compatibility; prefer from_global_stop_ids (plural) to describe a correspondence zone.
    from_global_stop_ids
    Type: string

    Comma-separated list of global stop IDs describing the origin correspondence zone (e.g. all platforms of a hub across different networks/parent stations). Each entry may be a platform stop id or a station stop id; stations are automatically expanded to their child platform stops when deciding whether to strip the initial walk leg. Routing origin: if from_lat and from_lon are provided, the coordinates are used to plan the trip. Otherwise the first valid stop's location from the list is used as a fallback. Walk-leg filtering: the initial walk leg is removed from a plan only when the itinerary actually boards at one of the provided stops (or at their parent station). Plans that board at an unrelated nearby stop keep their walk leg so the client can still present directions to the stop.
    to_lat
    Type: numberFormat: double

    Latitude of the destination location for the trip. Required unless to_global_stop_id or to_global_stop_ids is provided.
    to_lon
    Type: numberFormat: double

    Longitude of the destination location for the trip. Required unless to_global_stop_id or to_global_stop_ids is provided.
    to_global_stop_id
    Type: string

    Single global stop ID for the destination location. Kept for backward compatibility; prefer to_global_stop_ids (plural) to describe a correspondence zone.
    to_global_stop_ids
    Type: string

    Comma-separated list of global stop IDs describing the destination correspondence zone. Behaves symmetrically to from_global_stop_ids: coordinates win for routing when provided, otherwise the first valid stop's location is used; the final walk leg is stripped only when the itinerary actually alights at one of the provided stops.
    mode
    Type: stringenum

    The primary mode of transportation for the trip
    values
        transit
        microtransit
        personal_bike
        walk
        shared_mobility
    secondary_mode
    Type: stringenum

    This specifies the secondary mode of transportation for the trip, if applicable.

    This value allows for creating multimodal trips mixing transit and another mode. If a value other than walk is specified here, primary_mode must be set to transit.

    When this value is set, the planner attempts to replace the first and last legs of the trip with the specified mode if advantageous to do so. If it is not advantageous, a walk leg might be used instead.

    Note that the results generated are optimal given the specified modes, but they might not represent the absolute optimal trip overall. Depending on the context, it may be advantageous to compare the result of the multimodal plan against a direct plan (using only the primary mode) to ensure true optimality (i.e., a transit + microtransit result should likely be disregarded if the transit-only plan is faster).
    values
        microtransit
        personal_bike
        walk
        shared_mobility
    sharing_system_type
    Type: stringenum

    Specifies the type of shared mobility system when mode is set to shared_mobility.
        docked_bikeshare: Traditional docked bikeshare systems
        dockless_bikeshare: Dockless bikes
        scooters: Electric scooters

    If not specified, defaults to docked_bikeshare only.
    values
        docked_bikeshare
        dockless_bikeshare
        scooters
    leave_time
    Type: number

    UNIX timestamp representing the desired departure time for the trip. If both arrival_time and leave_time are provided, only leave_time is taken into account. By default, the current time is used.
    arrival_time
    Type: number

    UNIX timestamp representing the desired arrival time for the trip. If both arrival_time and leave_time are provided, only leave_time is taken into account.
    accessibility_need
    Type: stringenum

    This parameter specifies accessibility requirements for the trip. The following values are available:
        none: No specific accessibility needs are required; any valid trip may be returned.
        strict: Returns only strictly accessible trips. Specifically, this includes only trips using accessible stops and accessible routes/vehicles.
        prioritize_step_free: Prioritizes strictly accessible results but also includes less accessible alternatives (those with unknown or non-step-free accessibility).
    values
        none
        strict
        prioritize_step_free
    walk_reluctance
    Type: number

    This factor determines how costly walking is compared to riding in a transit vehicle within the trip plan. Values lower than 1.0 will be ignored. Transit, the app, uses a default value of 1.1, and 2.1 when the "Minimize Walking" mode is active.
    walk_speed
    Type: number
    min:  
    0.5
    max:  
    5

    The walking speed in meters per second for trip planning calculations. Must be between 0.5 and 5.0 m/s.
    should_include_directions
    Type: boolean

    Set to true to get step-by-step directions in the plan results.
    should_include_pathways
    Type: boolean

    Set to true to expand GTFS Pathways steps in direction items when entering or exiting a transit station. Requires should_include_directions to also be set to true.
    max_distance_between_location_and_stop
    Type: number

    This is the maximum distance allowed between the starting or destination locations and a transit stop. This value can be adjusted to optimize performance by limiting the search radius. By default, the value depends on the selected mode; for example, it is 1500 m for a standard mode=transit plan.
    should_update_realtime
    Type: boolean

    If true, the server will update the trip times in the response using real-time data, enhancing the schedule items with real time information. This happens after the initial route planning, which is still based on static schedule data.
    consider_downtimes
    Type: boolean

    If true, the planning will avoid any known downtimes identified in the service alerts. For example, if a subway is currently not working and has a severe service alert, the planner will offer results that work around that disruption. This parameter is ignored if the mode is set to anything other than transit.
    avoid_routes
    Type: string

    Comma-separated list of route identifiers to avoid in public transit routing. Each route identifier is a colon-separated pair of <feed_code>:<global_route_id>. This parameter is ignored if the mode is set to anything other than transit.
    avoid_stops
    Type: string

    Comma-separated list of stop identifiers to avoid in public transit routing. Each stop identifier is a colon-separated pair of <feed_code>:<stable_stop_id>. This parameter is ignored if the mode is set to anything other than transit.
    allowed_modes
    Type: string

    Comma-separated list of mode names to allow in public transit routing (e.g., "Bus,Metro,Train"). If specified, only routes with matching mode names will be considered for trip planning. Mode names should match the mode_name field returned in the route object. This parameter is ignored if the mode is set to anything other than transit.
    excluded_modes
    Type: string

    Comma-separated list of mode names to exclude from public transit routing (e.g., "Bus,Ferry"). If specified, routes with matching mode names will be excluded from trip planning. Mode names should match the mode_name field returned in the route object. This parameter is ignored if the mode is set to anything other than transit.
    allowed_networks
    Type: string

    If set, only the specified networks will be used to plan trips. A list of available networks can be obtained from /public/available_networks.

    This parameter will accept a comma-separated list containing network IDs, network locations or a combination of both. This parameter is ignored if the mode is set to anything other than transit.
    enable_network_previews
    Type: boolean

    If set to true, includes network previews in trip planning. By default, network previews are excluded from route planning results. This parameter is ignored if the mode is set to anything other than transit.
    num_result
    Type: number

    Number of results to return. This parameter is only considered for public transit only plans (mode=transit). Default is 3 for public transit only and bike plans, and 1 for walk plans.
    disable_walk_on_multimodal_fallback
    Type: boolean

    If true, disables the automatic walk fallback in multimodal trip planning. When enabled, the planner will only use the specified multimodal mode (e.g., bike, car) and only fallback to walking if no stops are accessible in the multimodal mode. This provides more control over transportation mode preferences in multimodal planning. This parameter only affects multimodal transit trips and is ignored for other modes.
    max_num_departures
    Type: integer
    min:  
    1
    max:  
    10

    Number of departures to return per stop
    max_num_legs
    Type: integer
    min:  
    1
    max:  
    6

    Maximum number of public transit legs (rides) in the trip plan. This parameter can be used to limit the complexity of the trip by restricting the number of transfers. Default is 3. Values outside the accepted range of 1 to 6 will be silently clamped, except for 0 which will use the default.
    next_departures_window
    Type: integer

    Only include departures that occur within this many minutes after the first returned departure. Departures outside this window will be excluded. If not provided, all available next departures are returned.
    soft_timeout
    Type: number

    Soft timeout for routing, in milliseconds. Once an optimal routing result is found AND this timeout is reached, the router will stop the search for suboptimal results.
    walk_fallback
    Type: boolean

    If true, returns a walk-only plan when the walk duration is 30 minutes or less and either no transit results are found or the walk duration is less than 1.5 times the shortest transit trip duration. The response will contain an additional result with one walk leg and walk directions (if should_include_directions is also set to true). This parameter only applies when mode=transit.
