$(".hamburger").on("click", function() {
    $(".hamburger").toggleClass("is-active")
    $(".mobile-menu").toggleClass("is-active")
    console.log("click event")
})