/**
 * Fetch the file contents of a given url.
 * @param {string} fileURL The file to be read from.
 * @returns Promise, contains file contents.
 */
async function fetchFileContent(fileURL) {
    return fetch(fileURL)
      .then(response => response.text());
}

/**
 * Get socials/links of an RDT lead.
 * @param {Object} lead An object containing an RDT lead's information.
 * @returns String, representing html content.
 */
const getLeadLinks = lead => {
    // Open div
    html = `<div class="member-links">`

    // Check for links
    if(lead.linkedin != null) {
        html += `<a target="_blank" href="${lead.linkedin}"><img src="./resources/icons/linkedin-icon.png" class="link-icon"></a>`
    }
    if(lead.github != null) {
        html += `<a target="_blank" href="${lead.github}"><img src="./resources/icons/github-icon.png" class="link-icon"></a>`
    }
    if(lead.instagram != null) {
        html += `<a target="_blank" href="${lead.instagram}"><img src="./resources/icons/insta-icon.png" class="link-icon"></a>`
    }

    // Close div and return
    html += "</div>"
    return html
}

/**
 * Build RDT Leadership cards & add them to the page.
 * @param {Array<Object>} rdtLeads A list of objects containing RDT lead information.
 */
const buildLeadCards = rdtLeads => {
    // For each lead...
    rdtLeads.forEach(lead => {
        // Get their headshot photo
        let lowerFirst = lead.first_name.toLowerCase();
        let lowerLast = lead.last_name.toLowerCase();
        let image = `./resources/lead_headshots/${lowerFirst}-${lowerLast}.jpg`;

        // Open & populate a new team card div
        cardHtml = `<div class="team-card">
                        <img src="${image}">
                        <div class="member-info">
                            <h2 class="member-position">${lead.position}</h2>
                            <p class="member-name">${lead.first_name} ${lead.last_name}</p>
                            <p class="member-bio">${lead.major} ${lead.graduation_year}</p>
                        </div>
                    `;

        // Get this leads socials
        cardHtml += getLeadLinks(lead)
        // Close the team card div
        cardHtml += "</div>"

        // Add team card to correct container
        competency = lead.competency.split(" ").join("-")
        $("#" + competency).append(cardHtml);
    });
}

const fileURL = 'lead_info.json';
fetchFileContent(fileURL)
.then(fileContent => JSON.parse(fileContent))
.then(obj => buildLeadCards(obj));
