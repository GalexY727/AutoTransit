# AutoTransit

AutoTransit is a Google Apps Script application that integrates seamlessly with your Google Calendar. It automatically creates bus entries for your calendar events, so you can have all your planning in one place.

## Features

- **Real-time Updates**: The application updates every minute or whenever you modify your target calendar, but only makes important api calls when things actually need to be updated.
- **Automatic Bus Entries**: For each event in your Google Calendar, AutoTransit generates bus entries to the specified destination, so you can keep your hands free.
- **TransitAPI Integration**: Utilizes the TransitAPI for real-time transit data, providing accurate information about bus schedules and routes.

## How It Works

1. **Setup**: Configure your AppsScript with the necessary properties, including your home address and target calendar ID.
2. **Event Monitoring**: The script monitors your calendar events and checks for upcoming events that require transit planning.
3. **Geocoding**: It geocodes your home address and event locations to obtain latitude and longitude coordinates.
4. **Transit Planning**: Using the TransitAPI, it calculates the best transit options to arrive at your events on time.
5. **Event Creation**: Automatically creates or updates bus entries in your target calendar based on the calculated transit plans.

## Requirements

- Google Account with access to Google Calendar API
- TransitAPI key for real-time transit data (I'm sure you can alternatively use Google Maps API or similar)

## Installation

2. Open Google Apps Script and create a new project.
3. Copy the contents of the `AppsScript.gs` file into your new project.
4. Set up the necessary properties in the script (you can initiate the "do not modify" vars to anything).
5. Deploy the script to run automatically using a trigger. You can setup a trigger to run on every calendar modification, but beware of recursion.

## License

This project is licensed under the GNU GPLv3 License.

![http://api-doc.transitapp.com/](https://uc10104cf7eea8d8b4a40d6f6e9d.previews.dropboxusercontent.com/p/thumb/AC6r6t2aagXhPEvOohIdWsuYx8lWTxoQf7J6s0EMRWuW-6x6gOjpgyLQdeleYdF-BgQZvSI-9Trt3ZPUo7SLQ47L0150qBKvyOYPxOkWtJe1iM9HmbAwJhpL6kLBLw4W_vUAxlDpQovRcedwGu4Ed0aIlbLlc1qDv0OK5cZNmN45ukWu48dh97pqpSj1zSmrQmaar0qyMJf-rNRdExZsC-etKHQ3gcLY2SMSNu8y2Gvd9IfOpdnYluNTrUNFsMp9Wl6DEpDp9_SnelxGNJbkb84DnhqAxz5hzZ42ysYedt9pBq4dYlk4MLOHRUBlZSFrvp8MRncPjkO5ieVkj_IVMOjW/p.png?fv_content=true&size_mode=5)